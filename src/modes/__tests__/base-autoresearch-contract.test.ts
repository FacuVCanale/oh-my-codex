import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readModeState, startMode, updateModeState } from '../base.js';
import { listActiveSkills, readVisibleSkillActiveState } from '../../state/skill-active.js';

describe('modes/base deep-interview contract integration', () => {


  it('startMode persists autoresearch state when no exclusive conflict exists', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-mode-autoresearch-contract-'));
    try {
      const started = await startMode('autoresearch', 'demo mission', 1, wd);
      assert.equal(started.mode, 'autoresearch');
      assert.equal(started.active, true);
      assert.equal(started.current_phase, 'starting');
      const persisted = await readModeState('autoresearch', wd);
      assert.equal(persisted?.mode, 'autoresearch');
      assert.equal(persisted?.task_description, 'demo mission');

      const canonical = await readVisibleSkillActiveState(wd);
      assert.deepEqual(
        listActiveSkills(canonical ?? {}).map(({ skill, phase }) => ({ skill, phase })),
        [{ skill: 'autoresearch', phase: 'starting' }],
      );
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('updateModeState syncs canonical autoresearch completion', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-mode-autoresearch-canonical-'));
    try {
      await startMode('autoresearch', 'demo mission', 1, wd);
      await updateModeState('autoresearch', {
        active: false,
        current_phase: 'complete',
        completed_at: '2026-04-11T00:00:00.000Z',
      }, wd);

      const canonical = await readVisibleSkillActiveState(wd);
      assert.ok(canonical);
      assert.equal(canonical?.active, false);
      assert.deepEqual(listActiveSkills(canonical ?? {}), []);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });
});
