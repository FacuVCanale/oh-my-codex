import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { cancelMode, updateAutopilotPipelineState, updateModeState } from '../base.js';

async function writeAutopilotState(wd: string, state: Record<string, unknown>): Promise<void> {
  await mkdir(join(wd, '.omx', 'state'), { recursive: true });
  await writeFile(join(wd, '.omx', 'state', 'autopilot-state.json'), JSON.stringify({
    active: true,
    mode: 'autopilot',
    iteration: 1,
    max_iterations: 10,
    started_at: '2026-06-09T00:00:00.000Z',
    ...state,
  }, null, 2));
}

describe('modes/base Autopilot gate integration', () => {









  it('cancelMode allows Autopilot cancellation from a gated implementation phase', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-mode-autopilot-cancel-'));
    try {
      await writeAutopilotState(wd, { current_phase: 'ultragoal' });
      await cancelMode('autopilot', wd);

      const raw = JSON.parse(await readFile(join(wd, '.omx', 'state', 'autopilot-state.json'), 'utf-8')) as Record<string, unknown>;
      assert.equal(raw.active, false);
      assert.equal(raw.current_phase, 'cancelled');
      assert.equal(raw.run_outcome, 'cancelled');
      assert.ok(typeof raw.completed_at === 'string' && raw.completed_at.length > 0);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });
});
