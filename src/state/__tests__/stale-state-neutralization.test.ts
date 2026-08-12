import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { neutralizeStaleWorkflowStateProjections } from '../operations.js';

/**
 * #3498 — Upgrade-time neutralization tests.
 *
 * Stale 0.20.x state fixtures (active ralph/ralplan/autopilot/transition
 * projections) must be neutralized cleanly on first 0.21 run:
 * - marked terminal (active: false, cancelled phase)
 * - never block a session
 * - idempotent (marker file prevents re-run)
 */

function fixture020xRalph(): Record<string, unknown> {
  return {
    active: true,
    mode: 'ralph',
    current_phase: 'execution',
    iteration: 3,
    max_iterations: 50,
    task_description: 'Fix the thing',
    started_at: '2026-06-01T10:00:00.000Z',
    owner_omx_session_id: 'sess-old-ralph',
  };
}

function fixture020xRalplan(): Record<string, unknown> {
  return {
    active: true,
    mode: 'ralplan',
    current_phase: 'consensus',
    iteration: 1,
    started_at: '2026-06-01T11:00:00.000Z',
    ralplan_consensus_gate: { complete: false },
  };
}

function fixture020xAutopilot(): Record<string, unknown> {
  return {
    active: true,
    mode: 'autopilot',
    current_phase: 'ralplan',
    iteration: 2,
    started_at: '2026-06-01T12:00:00.000Z',
  };
}

function fixtureTerminalRalph(): Record<string, unknown> {
  return {
    active: false,
    mode: 'ralph',
    current_phase: 'complete',
    completed_at: '2026-06-01T10:30:00.000Z',
  };
}

describe('Stale state neutralization (#3498)', () => {

  it('neutralizes active stale ralph state from 0.20.x on first run', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-neutralize-ralph-'));
    try {
      const stateDir = join(cwd, '.omx', 'state');
      const sessionDir = join(stateDir, 'sessions', 'sess-old-ralph');
      await mkdir(sessionDir, { recursive: true });

      const ralphPath = join(sessionDir, 'ralph-state.json');
      await writeFile(ralphPath, JSON.stringify(fixture020xRalph(), null, 2));

      const result = await neutralizeStaleWorkflowStateProjections(cwd);

      assert.equal(result.ran, true);
      assert.equal(result.neutralizedFiles.length, 1);
      assert.equal(result.neutralizedFiles[0], ralphPath);

      const neutralized = JSON.parse(await readFile(ralphPath, 'utf-8')) as Record<string, unknown>;
      assert.equal(neutralized.active, false);
      assert.equal(neutralized.current_phase, 'cancelled');
      assert.ok(neutralized.neutralized_at, 'must have neutralized_at timestamp');
      assert.equal(neutralized.neutralized_by, 'upgrade-0.21');
    } finally {
      await import('node:fs/promises').then((fs) => fs.rm(cwd, { recursive: true, force: true }));
    }
  });

  it('neutralizes active stale ralplan state from 0.20.x on first run', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-neutralize-ralplan-'));
    try {
      const stateDir = join(cwd, '.omx', 'state');
      const sessionDir = join(stateDir, 'sessions', 'sess-old-ralplan');
      await mkdir(sessionDir, { recursive: true });

      const ralplanPath = join(sessionDir, 'ralplan-state.json');
      await writeFile(ralplanPath, JSON.stringify(fixture020xRalplan(), null, 2));

      const result = await neutralizeStaleWorkflowStateProjections(cwd);

      assert.equal(result.ran, true);
      assert.equal(result.neutralizedFiles.length, 1);

      const neutralized = JSON.parse(await readFile(ralplanPath, 'utf-8')) as Record<string, unknown>;
      assert.equal(neutralized.active, false);
      assert.equal(neutralized.current_phase, 'cancelled');
    } finally {
      await import('node:fs/promises').then((fs) => fs.rm(cwd, { recursive: true, force: true }));
    }
  });

  it('neutralizes active stale autopilot state from 0.20.x on first run', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-neutralize-autopilot-'));
    try {
      const stateDir = join(cwd, '.omx', 'state');
      await mkdir(stateDir, { recursive: true });

      const autopilotPath = join(stateDir, 'autopilot-state.json');
      await writeFile(autopilotPath, JSON.stringify(fixture020xAutopilot(), null, 2));

      const result = await neutralizeStaleWorkflowStateProjections(cwd);

      assert.equal(result.ran, true);
      assert.equal(result.neutralizedFiles.length, 1);

      const neutralized = JSON.parse(await readFile(autopilotPath, 'utf-8')) as Record<string, unknown>;
      assert.equal(neutralized.active, false);
      assert.equal(neutralized.current_phase, 'cancelled');
    } finally {
      await import('node:fs/promises').then((fs) => fs.rm(cwd, { recursive: true, force: true }));
    }
  });

  it('does not neutralize already-terminal state', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-neutralize-terminal-'));
    try {
      const stateDir = join(cwd, '.omx', 'state');
      await mkdir(stateDir, { recursive: true });

      const ralphPath = join(stateDir, 'ralph-state.json');
      await writeFile(ralphPath, JSON.stringify(fixtureTerminalRalph(), null, 2));

      const result = await neutralizeStaleWorkflowStateProjections(cwd);

      assert.equal(result.ran, true);
      assert.equal(result.neutralizedFiles.length, 0);
      assert.ok(result.skipped >= 1, 'terminal state should be skipped');

      const unchanged = JSON.parse(await readFile(ralphPath, 'utf-8')) as Record<string, unknown>;
      assert.equal(unchanged.active, false);
      assert.equal(unchanged.current_phase, 'complete');
      assert.equal(unchanged.neutralized_by, undefined, 'terminal state should not be touched');
    } finally {
      await import('node:fs/promises').then((fs) => fs.rm(cwd, { recursive: true, force: true }));
    }
  });

  it('does not re-run after marker file exists (idempotent)', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-neutralize-idempotent-'));
    try {
      const stateDir = join(cwd, '.omx', 'state');
      const sessionDir = join(stateDir, 'sessions', 'sess-1');
      await mkdir(sessionDir, { recursive: true });

      const ralphPath = join(sessionDir, 'ralph-state.json');
      await writeFile(ralphPath, JSON.stringify(fixture020xRalph(), null, 2));

      // First run neutralizes.
      const first = await neutralizeStaleWorkflowStateProjections(cwd);
      assert.equal(first.ran, true);
      assert.equal(first.neutralizedFiles.length, 1);

      // Re-create stale state to simulate a race.
      await writeFile(ralphPath, JSON.stringify(fixture020xRalph(), null, 2));

      // Second run should not run (marker exists).
      const second = await neutralizeStaleWorkflowStateProjections(cwd);
      assert.equal(second.ran, false);
      assert.equal(second.neutralizedFiles.length, 0);

      // Marker file exists.
      assert.ok(
        existsSync(join(stateDir, 'state-neutralized-0.21.json')),
        'marker file must exist after first run',
      );
    } finally {
      await import('node:fs/promises').then((fs) => fs.rm(cwd, { recursive: true, force: true }));
    }
  });

  it('neutralizes across root and session scopes simultaneously', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-neutralize-multi-'));
    try {
      const rootStateDir = join(cwd, '.omx', 'state');
      const sessionStateDir = join(rootStateDir, 'sessions', 'sess-multi');
      await mkdir(sessionStateDir, { recursive: true });

      // Root ralph
      await writeFile(join(rootStateDir, 'ralph-state.json'), JSON.stringify(fixture020xRalph(), null, 2));
      // Session ralplan
      await writeFile(join(sessionStateDir, 'ralplan-state.json'), JSON.stringify(fixture020xRalplan(), null, 2));
      // Session autopilot
      await writeFile(join(sessionStateDir, 'autopilot-state.json'), JSON.stringify(fixture020xAutopilot(), null, 2));

      const result = await neutralizeStaleWorkflowStateProjections(cwd);

      assert.equal(result.ran, true);
      assert.equal(result.neutralizedFiles.length, 3, 'should neutralize all 3 stale projections');

      for (const path of result.neutralizedFiles) {
        const neutralized = JSON.parse(await readFile(path, 'utf-8')) as Record<string, unknown>;
        assert.equal(neutralized.active, false);
        assert.equal(neutralized.current_phase, 'cancelled');
      }
    } finally {
      await import('node:fs/promises').then((fs) => fs.rm(cwd, { recursive: true, force: true }));
    }
  });

  it('never throws on malformed state files', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-neutralize-malformed-'));
    try {
      const stateDir = join(cwd, '.omx', 'state');
      await mkdir(stateDir, { recursive: true });

      // Malformed JSON
      await writeFile(join(stateDir, 'ralph-state.json'), '{ "active": true, "broken": }');
      // Valid stale state alongside it
      await writeFile(join(stateDir, 'ralplan-state.json'), JSON.stringify(fixture020xRalplan(), null, 2));

      const result = neutralizeStaleWorkflowStateProjections(cwd);
      await assert.doesNotReject(result);

      const resolved = await result;
      assert.equal(resolved.ran, true);
      assert.equal(resolved.neutralizedFiles.length, 1, 'only the valid stale file should be neutralized');
    } finally {
      await import('node:fs/promises').then((fs) => fs.rm(cwd, { recursive: true, force: true }));
    }
  });

  it('skips skill-active-state.json (canonical skill state is separate)', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-neutralize-skip-skill-'));
    try {
      const stateDir = join(cwd, '.omx', 'state');
      await mkdir(stateDir, { recursive: true });

      const skillActivePath = join(stateDir, 'skill-active-state.json');
      await writeFile(skillActivePath, JSON.stringify({
        version: 1,
        active: true,
        skill: 'ralph',
        active_skills: [{ skill: 'ralph', phase: 'execution', active: true }],
      }, null, 2));

      const result = await neutralizeStaleWorkflowStateProjections(cwd);

      assert.equal(result.ran, true);
      assert.equal(result.neutralizedFiles.length, 0, 'skill-active-state.json should not be neutralized here');

      const unchanged = JSON.parse(await readFile(skillActivePath, 'utf-8')) as Record<string, unknown>;
      assert.equal(unchanged.active, true, 'skill-active-state.json should be untouched');
    } finally {
      await import('node:fs/promises').then((fs) => fs.rm(cwd, { recursive: true, force: true }));
    }
  });
});
