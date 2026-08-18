import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { validateAutopilotCompletionTransition, type AutopilotCompletionAdvisory } from '../completion-gate.js';
import { updateModeState } from '../../modes/base.js';
import { executeStateOperation } from '../../state/operations.js';
import { SKILL_ACTIVE_STATE_FILE } from '../../state/skill-active.js';
import { recordSkillActivation } from '../../hooks/keyword-detector.js';

type GateCase = {
  name: string;
  currentPhase: string;
  nextPhase: string;
  terminal: boolean;
  skippedGate: string;
  missingEvidence: string;
  keywordPhase?: string;
};

const GATE_CASES: readonly GateCase[] = [
  {
    name: 'unknown active phase terminalization',
    currentPhase: 'bogus',
    nextPhase: 'complete',
    terminal: true,
    skippedGate: 'autopilot-phase',
    missingEvidence: 'a valid active Autopilot phase before terminalization',
  },
  {
    name: 'deep-interview terminalization',
    currentPhase: 'deep-interview',
    nextPhase: 'complete',
    terminal: true,
    skippedGate: 'ralplan',
    missingEvidence: 'the required deep-interview to ralplan transition',
  },
  {
    name: 'deep-interview handoff skip',
    currentPhase: 'deep-interview',
    nextPhase: 'ralplan',
    terminal: false,
    skippedGate: 'deep-interview-handoff',
    missingEvidence: 'a durable completed interview gate and handoff artifact',
    keywordPhase: 'ralplan',
  },
  {
    name: 'ralplan terminalization',
    currentPhase: 'ralplan',
    nextPhase: 'complete',
    terminal: true,
    skippedGate: 'ultragoal',
    missingEvidence: 'the required ralplan to ultragoal transition',
  },
  {
    name: 'ralplan handoff skip',
    currentPhase: 'ralplan',
    nextPhase: 'ultragoal',
    terminal: false,
    skippedGate: 'ralplan-handoff',
    missingEvidence: 'durable planning artifacts, sequential Architect and Critic approvals, and a bound execution handoff',
    keywordPhase: 'ultragoal',
  },
  {
    name: 'implementation terminalization',
    currentPhase: 'ultragoal',
    nextPhase: 'complete',
    terminal: true,
    skippedGate: 'code-review',
    missingEvidence: 'the required implementation to code-review transition',
  },
  {
    name: 'implementation to ultraqa skip',
    currentPhase: 'ultragoal',
    nextPhase: 'ultraqa',
    terminal: false,
    skippedGate: 'code-review',
    missingEvidence: 'a code-review transition before ultraqa',
    keywordPhase: 'ultraqa',
  },
  {
    name: 'non-matrix phase-order skip',
    currentPhase: 'deep-interview',
    nextPhase: 'ultragoal',
    terminal: false,
    skippedGate: 'phase-order',
    missingEvidence: 'an allowed adjacent transition from deep-interview to ultragoal',
    keywordPhase: 'ultragoal',
  },
  {
    name: 'code-review terminalization',
    currentPhase: 'code-review',
    nextPhase: 'complete',
    terminal: true,
    skippedGate: 'ultraqa',
    missingEvidence: 'the required code-review to ultraqa transition',
  },
  {
    name: 'ultraqa terminalization without clean evidence',
    currentPhase: 'ultraqa',
    nextPhase: 'complete',
    terminal: true,
    skippedGate: 'ultraqa-evidence',
    missingEvidence: 'clean code-review and ultraqa verdict evidence',
  },
];

function assertAdvisory(
  advisory: AutopilotCompletionAdvisory | null | undefined,
  expected: GateCase,
): asserts advisory is AutopilotCompletionAdvisory {
  assert.ok(advisory);
  assert.equal(advisory.skippedGate, expected.skippedGate);
  assert.equal(advisory.missingEvidence, expected.missingEvidence);
  assert.ok(advisory.message.length > 0);
}

function nextFields(testCase: GateCase): Record<string, unknown> {
  return testCase.terminal
    ? { active: false, current_phase: 'complete' }
    : { active: true, current_phase: testCase.nextPhase };
}

async function writeAutopilotState(
  cwd: string,
  state: Record<string, unknown>,
  sessionId?: string,
): Promise<string> {
  const stateDir = join(cwd, '.omx', 'state');
  const targetDir = sessionId ? join(stateDir, 'sessions', sessionId) : stateDir;
  await mkdir(targetDir, { recursive: true });
  const path = join(targetDir, 'autopilot-state.json');
  await writeFile(path, JSON.stringify({
    active: true,
    mode: 'autopilot',
    workingDirectory: cwd,
    ...(sessionId ? { session_id: sessionId } : {}),
    ...state,
  }, null, 2));
  return path;
}

async function readState(path: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(path, 'utf-8')) as Record<string, unknown>;
}

function skippedGates(state: Record<string, unknown>): AutopilotCompletionAdvisory[] {
  return Array.isArray(state.skipped_gates)
    ? state.skipped_gates as AutopilotCompletionAdvisory[]
    : [];
}

function assertPersistedAdvisory(state: Record<string, unknown>, testCase: GateCase): void {
  const entries = skippedGates(state);
  assert.equal(entries.length, 1);
  assertAdvisory(entries[0], testCase);
  if (testCase.terminal) {
    assert.equal(state.completion_status, 'complete-with-skipped-gates');
    assert.notEqual(state.completion_status, 'success');
  }
}

async function withIsolatedRoot<T>(cwd: string, run: () => Promise<T>): Promise<T> {
  const previousRoot = process.env.OMX_ROOT;
  process.env.OMX_ROOT = cwd;
  try {
    return await run();
  } finally {
    if (previousRoot === undefined) delete process.env.OMX_ROOT;
    else process.env.OMX_ROOT = previousRoot;
  }
}

describe('Autopilot completion advisory contract', () => {
  it('maps every formerly refused check and exercises all three transports where representable', async () => {
    for (const [index, testCase] of GATE_CASES.entries()) {
      const current = { mode: 'autopilot', active: true, current_phase: testCase.currentPhase };
      const next = { mode: 'autopilot', ...nextFields(testCase) };
      const direct = validateAutopilotCompletionTransition(current, next);
      assertAdvisory(direct, testCase);

      const baseCwd = await mkdtemp(join(tmpdir(), `omx-advisory-base-${index}-`));
      try {
        const basePath = await writeAutopilotState(baseCwd, { current_phase: testCase.currentPhase });
        const updated = await updateModeState('autopilot', nextFields(testCase), baseCwd);
        assert.equal(updated.current_phase, testCase.nextPhase);
        assertAdvisory(skippedGates(updated)[0], testCase);
        assertPersistedAdvisory(await readState(basePath), testCase);

        // Scope guard remains fail-closed on the mode transport.
        await assert.rejects(
          () => updateModeState('autopilot', { workingDirectory: join(baseCwd, 'foreign') }, baseCwd),
          /workingDirectory must match/,
        );
      } finally {
        await rm(baseCwd, { recursive: true, force: true });
      }

      const operationCwd = await mkdtemp(join(tmpdir(), `omx-advisory-state-${index}-`));
      const sessionId = `sess-advisory-${index}`;
      try {
        const operationPath = await writeAutopilotState(operationCwd, { current_phase: testCase.currentPhase }, sessionId);
        await withIsolatedRoot(operationCwd, async () => {
          const response = await executeStateOperation('state_write', {
            workingDirectory: operationCwd,
            session_id: sessionId,
            mode: 'autopilot',
            ...nextFields(testCase),
          });
          assert.equal(response.isError, undefined);
          assertAdvisory((response.payload as { advisory?: AutopilotCompletionAdvisory }).advisory, testCase);
          assertPersistedAdvisory(await readState(operationPath), testCase);

          // Identity guard remains fail-closed on the state-operation transport.
          const foreign = await executeStateOperation('state_write', {
            workingDirectory: operationCwd,
            session_id: sessionId,
            mode: 'autopilot',
            state: { session_id: 'foreign-session' },
            ...nextFields(testCase),
          });
          assert.equal(foreign.isError, true);
          assert.match(String((foreign.payload as { error?: string }).error), /session_id must match/);
        });
      } finally {
        await rm(operationCwd, { recursive: true, force: true });
      }

      if (!testCase.keywordPhase) {
        // Terminal rows are intentionally not representable through the keyword
        // transport: recordSkillActivation only advances active child phases.
        continue;
      }

      const keywordCwd = await mkdtemp(join(tmpdir(), `omx-advisory-keyword-${index}-`));
      const keywordSessionId = `sess-keyword-advisory-${index}`;
      try {
        const keywordStateDir = join(keywordCwd, '.omx', 'state');
        const keywordPath = await writeAutopilotState(keywordCwd, { current_phase: testCase.currentPhase }, keywordSessionId);
        const sessionDir = join(keywordStateDir, 'sessions', keywordSessionId);
        await writeFile(join(sessionDir, SKILL_ACTIVE_STATE_FILE), JSON.stringify({
          version: 1,
          active: true,
          skill: 'autopilot',
          keyword: '$autopilot',
          phase: testCase.currentPhase,
          activated_at: '2026-08-01T00:00:00.000Z',
          updated_at: '2026-08-01T00:00:00.000Z',
          source: 'keyword-detector',
          session_id: keywordSessionId,
          active_skills: [{ skill: 'autopilot', active: true, phase: testCase.currentPhase, session_id: keywordSessionId }],
        }, null, 2));

        const result = await recordSkillActivation({
          stateDir: keywordStateDir,
          sourceCwd: keywordCwd,
          text: `$${testCase.keywordPhase}`,
          sessionId: keywordSessionId,
          nowIso: '2026-08-01T00:00:01.000Z',
        });
        assert.ok(result);
        assert.equal(result.phase, testCase.keywordPhase);
        assertAdvisory(result.advisory as AutopilotCompletionAdvisory | undefined, testCase);
        assertPersistedAdvisory(await readState(keywordPath), testCase);

        // Malformed detail state remains fail-closed on the keyword transport.
        await writeFile(keywordPath, '{malformed');
        const corrupted = await recordSkillActivation({
          stateDir: keywordStateDir,
          sourceCwd: keywordCwd,
          text: `$${testCase.keywordPhase}`,
          sessionId: keywordSessionId,
          nowIso: '2026-08-01T00:00:02.000Z',
        });
        assert.match(String(corrupted?.transition_error), /detail state is malformed/);
      } finally {
        await rm(keywordCwd, { recursive: true, force: true });
      }
    }
  });

  it('keeps a non-canonical interview artifact root fail-closed', () => {
    assert.throws(
      () => validateAutopilotCompletionTransition(
        { mode: 'autopilot', active: true, current_phase: 'deep-interview', workingDirectory: '/tmp/workspace' },
        {
          mode: 'autopilot',
          active: true,
          current_phase: 'ralplan',
          workingDirectory: '/tmp/workspace',
          handoff_artifacts: { deep_interview: { spec_path: '.omx/state/forged.md' } },
        },
      ),
      /out-of-scope artifact path/,
    );
  });
});
