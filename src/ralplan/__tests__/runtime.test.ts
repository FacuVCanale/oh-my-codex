import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readModeState, startMode } from '../../modes/base.js';
import { getBaseStateDir, getStatePath } from '../../state/paths.js';
import { writeRoleRoutingMarker } from '../../subagents/role-routing-marker.js';
import { subagentTrackingPath } from '../../subagents/tracker.js';
import { cancelRalplanConsensus, runRalplanConsensus } from '../runtime.js';

function sessionStatePath(cwd: string, sessionId: string): string {
  return getStatePath('ralplan', cwd, sessionId);
}

async function writeSessionPointer(cwd: string, sessionId: string): Promise<void> {
  const stateDir = join(cwd, '.omx', 'state');
  await mkdir(stateDir, { recursive: true });
  await writeFile(join(stateDir, 'session.json'), JSON.stringify({
    session_id: sessionId,
    cwd,
    state_root: stateDir,
  }));
}

async function readScopedRalplanState(cwd: string, sessionId: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(sessionStatePath(cwd, sessionId), 'utf-8'));
}

async function writeNativeSubagentTracking(cwd: string, sessionId: string): Promise<void> {
  const architectCompletedAt = '2026-05-28T00:00:00.000Z';
  const criticStartedAt = '2026-05-28T00:05:00.000Z';
  const criticCompletedAt = '2026-05-28T00:10:00.000Z';
  const trackingPath = subagentTrackingPath(cwd);
  await mkdir(join(trackingPath, '..'), { recursive: true });
  await writeFile(trackingPath, JSON.stringify({
    schemaVersion: 1,
    sessions: {
      [sessionId]: {
        session_id: sessionId,
        leader_thread_id: 'thread-leader',
        updated_at: criticCompletedAt,
        threads: {
          'thread-leader': {
            thread_id: 'thread-leader',
            kind: 'leader',
            first_seen_at: architectCompletedAt,
            last_seen_at: architectCompletedAt,
            turn_count: 1,
          },
          'thread-architect': {
            thread_id: 'thread-architect',
            kind: 'subagent',
            first_seen_at: architectCompletedAt,
            last_seen_at: architectCompletedAt,
            completed_at: architectCompletedAt,
            turn_count: 1,
            role: 'architect',
          },
          'thread-critic': {
            thread_id: 'thread-critic',
            kind: 'subagent',
            first_seen_at: criticStartedAt,
            last_seen_at: criticCompletedAt,
            completed_at: criticCompletedAt,
            turn_count: 1,
            role: 'critic',
          },
        },
      },
    },
  }, null, 2));
}

async function writeAdaptedSubagentTracking(cwd: string, sessionId: string): Promise<void> {
  await writeNativeSubagentTracking(cwd, sessionId);
  const trackingPath = subagentTrackingPath(cwd);
  const tracking = JSON.parse(await readFile(trackingPath, 'utf-8')) as {
    sessions: Record<string, { threads: Record<string, Record<string, unknown>> }>;
  };
  const threads = tracking.sessions[sessionId]?.threads;
  if (!threads) throw new Error('adapted_subagent_tracking_fixture_missing');
  for (const [threadId, role] of [['thread-architect', 'architect'], ['thread-critic', 'critic']] as const) {
    threads[threadId] = {
      ...threads[threadId],
      role,
      provenance_kind: 'omx_adapted',
    };
  }
  threads['thread-architect'] = {
    ...threads['thread-architect'],
    first_seen_at: '2026-05-28T00:00:00.000Z',
    last_seen_at: '2026-05-28T00:00:00.000Z',
    completed_at: '2026-05-28T00:00:00.000Z',
  };
  threads['thread-critic'] = {
    ...threads['thread-critic'],
    first_seen_at: '2026-05-28T00:05:00.000Z',
    last_seen_at: '2026-05-28T00:05:00.000Z',
    completed_at: '2026-05-28T00:05:00.000Z',
  };
  await writeFile(trackingPath, JSON.stringify(tracking, null, 2));
  writeRoleRoutingMarker(getBaseStateDir(cwd), {
    schema_version: 1,
    cwd,
    session_id: sessionId,
    parent_thread_id: 'thread-leader',
    observed_at: '2026-07-13T10:00:00.000Z',
    expires_at: new Date(Date.now() + 60_000).toISOString(),
    evidence: 'OMX adapted role intent consumed for native child SessionStart',
  });
}

describe('ralplan runtime', () => {
  let savedOmxEnv: Pick<NodeJS.ProcessEnv, 'OMX_ROOT' | 'OMX_STATE_ROOT' | 'OMX_TEAM_STATE_ROOT' | 'OMX_SESSION_ID'>;

  beforeEach(() => {
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
  });

  afterEach(() => {
    for (const key of ['OMX_ROOT', 'OMX_STATE_ROOT', 'OMX_TEAM_STATE_ROOT', 'OMX_SESSION_ID'] as const) {
      const value = savedOmxEnv[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });











  it('marks failed cleanly when execution throws', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-ralplan-runtime-fail-'));
    const sessionId = 'sess-ralplan-fail';
    try {
      await mkdir(join(sessionStatePath(cwd, sessionId), '..'), { recursive: true });
      await writeSessionPointer(cwd, sessionId);

      const result = await runRalplanConsensus({
        async draft() {
          return { summary: 'draft' };
        },
        async architectReview() {
          throw new Error('architect blew up');
        },
        async criticReview() {
          throw new Error('should not run');
        },
      }, { task: 'failing ralplan runtime', cwd });

      assert.equal(result.status, 'failed');
      assert.match(result.error || '', /architect blew up/);

      const finalState = await readModeState('ralplan', cwd);
      assert.equal(finalState?.active, false);
      assert.equal(finalState?.current_phase, 'failed');
      assert.match(String(finalState?.status_message || ''), /Status: failed/);
      assert.match(String(finalState?.error || ''), /architect blew up/);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('marks cancelled state cleanly', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-ralplan-runtime-cancel-'));
    const sessionId = 'sess-ralplan-cancel';
    try {
      await mkdir(join(sessionStatePath(cwd, sessionId), '..'), { recursive: true });
      await writeSessionPointer(cwd, sessionId);

      await startMode('ralplan', 'cancel me', 2, cwd);
      await cancelRalplanConsensus(cwd);

      const finalState = await readModeState('ralplan', cwd);
      assert.equal(finalState?.active, false);
      assert.equal(finalState?.current_phase, 'cancelled');
      assert.ok(typeof finalState?.completed_at === 'string' && finalState.completed_at.length > 0);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
