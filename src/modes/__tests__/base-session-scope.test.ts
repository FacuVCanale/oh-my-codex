import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { assertModeStartAllowed, readModeState, startMode, updateModeState } from '../base.js';


async function writeSessionPointer(wd: string, sessionId: string): Promise<void> {
  const stateDir = join(wd, '.omx', 'state');
  await mkdir(stateDir, { recursive: true });
  await writeFile(join(stateDir, 'session.json'), JSON.stringify({
    session_id: sessionId,
    cwd: wd,
    state_root: stateDir,
  }));
}

describe('modes/base session-scoped persistence', () => {

  it('preserves explicit fork updates when the implicit OMX_SESSION_ID is unmatched', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-mode-explicit-fork-'));
    const previousSessionId = process.env.OMX_SESSION_ID;
    try {
      const stateDir = join(wd, '.omx', 'state');
      const forkSessionId = 'explicit-fork';
      const forkStatePath = join(stateDir, 'sessions', forkSessionId, 'ralplan-state.json');
      await mkdir(join(stateDir, 'sessions', forkSessionId), { recursive: true });
      await writeFile(join(stateDir, 'session.json'), JSON.stringify({ session_id: 'sess-canonical', cwd: wd }));
      await writeFile(forkStatePath, JSON.stringify({
        active: true,
        mode: 'ralplan',
        iteration: 0,
        max_iterations: 5,
        current_phase: 'starting',
      }));
      process.env.OMX_SESSION_ID = 'sess-unmatched';

      await updateModeState('ralplan', { current_phase: 'planning', iteration: 1 }, wd, forkSessionId);

      const updated = JSON.parse(await readFile(forkStatePath, 'utf-8')) as Record<string, unknown>;
      assert.equal(updated.current_phase, 'planning');
      assert.equal(updated.iteration, 1);
      assert.equal(existsSync(join(stateDir, 'sessions', 'sess-unmatched')), false);
    } finally {
      if (typeof previousSessionId === 'string') process.env.OMX_SESSION_ID = previousSessionId;
      else delete process.env.OMX_SESSION_ID;
      await rm(wd, { recursive: true, force: true });
    }
  });

});
