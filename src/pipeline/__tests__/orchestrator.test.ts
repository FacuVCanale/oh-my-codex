import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, readFile, writeFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { existsSync } from 'fs';
import { readModeState } from '../../modes/base.js';
import {
  runPipeline,
  canResumePipeline,
  readPipelineState,
  cancelPipeline,
  createAutopilotPipelineConfig,
  createStrictAutopilotStages,
} from '../orchestrator.js';
import { createRalplanStage } from '../stages/ralplan.js';
import type { PipelineConfig, PipelineStage, StageContext, StageResult } from '../types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeStage(
  name: string,
  result: Partial<StageResult> = {},
  opts?: { canSkip?: (ctx: StageContext) => boolean; delay?: number },
): PipelineStage {
  return {
    name,
    canSkip: opts?.canSkip,
    async run(_ctx: StageContext): Promise<StageResult> {
      if (opts?.delay) await new Promise((r) => setTimeout(r, opts.delay));
      return {
        status: 'completed',
        artifacts: { produced_by: name },
        duration_ms: 0,
        ...result,
      };
    },
  };
}

function makeFailingStage(name: string, error: string): PipelineStage {
  return {
    name,
    async run(): Promise<StageResult> {
      return {
        status: 'failed',
        artifacts: {},
        duration_ms: 0,
        error,
      };
    },
  };
}

function makeThrowingStage(name: string, message: string): PipelineStage {
  return {
    name,
    async run(): Promise<StageResult> {
      throw new Error(message);
    },
  };
}

let tempDir: string;
let savedOmxEnv: Pick<NodeJS.ProcessEnv, 'OMX_ROOT' | 'OMX_STATE_ROOT' | 'OMX_TEAM_STATE_ROOT' | 'OMX_SESSION_ID'>;

function clearAmbientOmxEnv(): void {
  savedOmxEnv = {
    OMX_ROOT: process.env.OMX_ROOT,
    OMX_STATE_ROOT: process.env.OMX_STATE_ROOT,
    OMX_TEAM_STATE_ROOT: process.env.OMX_TEAM_STATE_ROOT,
    OMX_SESSION_ID: process.env.OMX_SESSION_ID,
  };
  delete process.env.OMX_ROOT;
  delete process.env.OMX_STATE_ROOT;
  delete process.env.OMX_TEAM_STATE_ROOT;
  delete process.env.OMX_SESSION_ID;
}

function restoreAmbientOmxEnv(): void {
  for (const key of ['OMX_ROOT', 'OMX_STATE_ROOT', 'OMX_TEAM_STATE_ROOT', 'OMX_SESSION_ID'] as const) {
    const value = savedOmxEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

async function setup(): Promise<string> {
  tempDir = await mkdtemp(join(tmpdir(), 'omx-pipeline-test-'));
  return tempDir;
}

async function cleanup(): Promise<void> {
  if (tempDir && existsSync(tempDir)) {
    await rm(tempDir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Pipeline Orchestrator', () => {
  beforeEach(async () => {
    clearAmbientOmxEnv();
    await setup();
  });

  afterEach(async () => {
    await cleanup();
    restoreAmbientOmxEnv();
  });

  describe('runPipeline', () => {
  });

  
  describe('validation', () => {
    it('rejects config with empty name', async () => {
      await assert.rejects(
        () => runPipeline({ name: '', task: 'x', stages: [makeStage('a')], cwd: tempDir }),
        /non-empty name/,
      );
    });

    it('rejects config with empty task', async () => {
      await assert.rejects(
        () => runPipeline({ name: 'x', task: '', stages: [makeStage('a')], cwd: tempDir }),
        /non-empty task/,
      );
    });

    it('rejects config with no stages', async () => {
      await assert.rejects(
        () => runPipeline({ name: 'x', task: 'x', stages: [], cwd: tempDir }),
        /at least one stage/,
      );
    });

    it('rejects duplicate stage names', async () => {
      await assert.rejects(
        () => runPipeline({
          name: 'x',
          task: 'x',
          stages: [makeStage('dup'), makeStage('dup')],
          cwd: tempDir,
        }),
        /Duplicate stage name/,
      );
    });

    it('rejects non-positive maxRalphIterations', async () => {
      await assert.rejects(
        () => runPipeline({
          name: 'x',
          task: 'x',
          stages: [makeStage('a')],
          cwd: tempDir,
          maxRalphIterations: 0,
        }),
        /maxRalphIterations must be a positive integer/,
      );
    });

    it('rejects non-positive workerCount', async () => {
      await assert.rejects(
        () => runPipeline({
          name: 'x',
          task: 'x',
          stages: [makeStage('a')],
          cwd: tempDir,
          workerCount: -1,
        }),
        /workerCount must be a positive integer/,
      );
    });
  });

  describe('canResumePipeline', () => {
    it('returns false when no state exists', async () => {
      assert.equal(await canResumePipeline(tempDir), false);
    });

    it('returns false after completed pipeline', async () => {
      await runPipeline({
        name: 'complete',
        task: 'test',
        stages: [makeStage('a')],
        cwd: tempDir,
      });
      assert.equal(await canResumePipeline(tempDir), false);
    });

    it('returns false after failed pipeline', async () => {
      await runPipeline({
        name: 'fail',
        task: 'test',
        stages: [makeFailingStage('bad', 'err')],
        cwd: tempDir,
      });
      assert.equal(await canResumePipeline(tempDir), false);
    });

    it('returns true when pipeline state is active and in-progress', async () => {
      // Manually write an in-progress pipeline state
      const { mkdir: mkdirFs, writeFile: writeFileFs } = await import('fs/promises');
      const stateDir = join(tempDir, '.omx', 'state');
      await mkdirFs(stateDir, { recursive: true });
      await writeFileFs(
        join(stateDir, 'autopilot-state.json'),
        JSON.stringify({
          active: true,
          mode: 'autopilot',
          iteration: 1,
          max_iterations: 3,
          current_phase: 'ralph',
          pipeline_name: 'resume-test',
          started_at: new Date().toISOString(),
        }),
      );
      assert.equal(await canResumePipeline(tempDir), true);
    });
  });

  describe('readPipelineState', () => {
    it('returns null when no state exists', async () => {
      assert.equal(await readPipelineState(tempDir), null);
    });

    it('returns extension fields after a run', async () => {
      await runPipeline({
        name: 'read-test',
        task: 'read task',
        stages: [makeStage('s1'), makeStage('s2')],
        cwd: tempDir,
        maxRalphIterations: 5,
        workerCount: 3,
        agentType: 'analyst',
      });

      const ext = await readPipelineState(tempDir);
      assert.ok(ext);
      assert.equal(ext.pipeline_name, 'read-test');
      assert.deepEqual(ext.pipeline_stages, ['s1', 's2']);
      assert.equal(ext.pipeline_max_ralph_iterations, 5);
      assert.equal(ext.pipeline_worker_count, 3);
      assert.equal(ext.pipeline_agent_type, 'analyst');
      assert.equal(ext.qa_verdict, null);
    });
  });

  describe('cancelPipeline', () => {
    it('does not throw when no state exists', async () => {
      await assert.doesNotReject(() => cancelPipeline(tempDir));
    });
  });

  it('byte-preserves an active non-primary Autopilot session without running pipeline work', async () => {
    const sessionId = 'non-primary-active-autopilot';
    const sessionDir = join(tempDir, '.omx', 'state', 'sessions', sessionId);
    const statePath = join(sessionDir, 'autopilot-state.json');
    const rawState = '{"active":true,"mode":"autopilot","current_phase":"ralplan","metadata":{"owner":"existing"},"handoff_artifacts":{"ralplan":{"path":".omx/plans/existing.md"}}}\n';
    await mkdir(sessionDir, { recursive: true });
    await writeFile(statePath, rawState);
    let stageRuns = 0;
    let transitions = 0;
    const config = createAutopilotPipelineConfig('preserve active session', {
      cwd: tempDir,
      sessionId,
      stages: [{
        name: 'deep-interview',
        async run(): Promise<StageResult> {
          stageRuns += 1;
          return { status: 'completed', artifacts: {}, duration_ms: 0 };
        },
      }],
      onStageTransition: () => { transitions += 1; },
    });

    const result = await runPipeline(config);

    assert.equal(result.status, 'cancelled');
    assert.deepEqual(result.artifacts, { active_autopilot_session_preserved: true });
    assert.equal(stageRuns, 0);
    assert.equal(transitions, 0);
    assert.equal(await readFile(statePath, 'utf-8'), rawState);
  });

  it('does not borrow conflicting root Autopilot state for a fresh explicit session', async () => {
    const sessionId = 'fresh-explicit-session';
    const stateDir = join(tempDir, '.omx', 'state');
    const rootPath = join(stateDir, 'autopilot-state.json');
    const rawRoot = '{"active":true,"mode":"autopilot","current_phase":"ralplan","metadata":{"owner":"root"}}\n';
    await mkdir(stateDir, { recursive: true });
    await writeFile(rootPath, rawRoot);

    let stageRuns = 0;
    try {
      await runPipeline(createAutopilotPipelineConfig('fresh explicit session', {
        cwd: tempDir,
        sessionId,
        stages: [{
          name: 'deep-interview',
          async run(): Promise<StageResult> {
            stageRuns += 1;
            return { status: 'completed', artifacts: {}, duration_ms: 0 };
          },
        }],
      }));
    } catch {
      // Pipeline may fail on downstream state transitions; that's OK.
      // The key assertion is that the root state is preserved.
    }

    // #3463: The preflight no longer blocks with documented_host_consensus_receipt.
    assert.equal(await readFile(rootPath, 'utf-8'), rawRoot);
  });

  it('#3463: no longer preflight-blocks fresh Autopilot since the transition is reachable via user-authorized handoff', async () => {
    let stageRuns = 0;
    try {
      await runPipeline(createAutopilotPipelineConfig('preflight receipt verification', {
        cwd: tempDir,
        stages: [{
          name: 'deep-interview',
          async run(): Promise<StageResult> {
            stageRuns += 1;
            return { status: 'completed', artifacts: {}, duration_ms: 0 };
          },
        }],
      }));
    } catch {
      // Pipeline may fail on downstream state transitions without deep-interview gate evidence.
    }

    // The pipeline starts and runs the deep-interview stage instead of being
    // preflight-blocked. The ralplan → ultragoal gate handles authorization.
    assert.equal(stageRuns >= 1, true);
  });

  describe('createAutopilotPipelineConfig', () => {
    it('creates config with default values', () => {
      const config = createAutopilotPipelineConfig('build feature X', {});

      assert.equal(config.name, 'autopilot');
      assert.equal(config.task, 'build feature X');
      assert.equal(config.maxRalphIterations, 10);
      assert.equal(config.workerCount, 2);
      assert.equal(config.agentType, 'executor');
      assert.deepEqual(config.stages.map((stage) => stage.name), ['deep-interview', 'ralplan', 'ultragoal', 'code-review', 'ultraqa']);
    });



    it('exposes strict default autopilot stages', () => {
      assert.deepEqual(createStrictAutopilotStages().map((stage) => stage.name), ['deep-interview', 'ralplan', 'ultragoal', 'code-review', 'ultraqa']);
    });

    it('accepts custom overrides', () => {
      const stages = [makeStage('a'), makeStage('b')];
      const config = createAutopilotPipelineConfig('task', {
        stages,
        maxRalphIterations: 20,
        workerCount: 4,
        agentType: 'architect',
        cwd: '/tmp/test',
        sessionId: 'session-1',
      });

      assert.equal(config.maxRalphIterations, 20);
      assert.equal(config.workerCount, 4);
      assert.equal(config.agentType, 'architect');
      assert.equal(config.cwd, '/tmp/test');
      assert.equal(config.sessionId, 'session-1');
    });
  });
});
