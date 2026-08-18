import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { existsSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir as osTmpdir } from 'node:os';

// macOS resolves TMPDIR through /var -> /private/var; canonicalize so fixture paths compare
// equal to the realpath-based paths the repair path reports.
const tmpdir = (): string => realpathSync(osTmpdir());

import { repairStateProjections } from '../../cli/doctor.js';

/**
 * #3498 follow-up — stale-state retirement is explicit, never automatic.
 *
 * The automatic launch-time neutralizer was removed. It rewrote any active
 * non-terminal `{mode}-state.json` in place with no version, schema, owner, or
 * provenance check, so a valid CURRENT run could be terminalized
 * (`active: false`, `current_phase: 'cancelled'`) on first launch. A real
 * projection carries no `version`/`updated_at`/`state_revision` marker, so
 * there was no evidence to distinguish 0.20.x from 0.21 state.
 *
 * The retained path is `omx doctor --repair-state`, which archives under
 * `.omx/archive/` instead of mutating, and preserves the session scope selected
 * by the canonical pointer.
 */

function activeRalphProjection(): Record<string, unknown> {
  return {
    active: true,
    mode: 'ralph',
    current_phase: 'execution',
    iteration: 3,
    max_iterations: 50,
    task_description: 'Fix the thing',
    started_at: '2026-06-01T10:00:00.000Z',
  };
}

async function seedSession(root: string, sessionId: string): Promise<string> {
  const stateDir = join(root, '.omx', 'state');
  await mkdir(stateDir, { recursive: true });
  await writeFile(
    join(stateDir, 'session.json'),
    JSON.stringify({ session_id: sessionId, cwd: root, state_root: stateDir }),
  );
  const sessionDir = join(stateDir, 'sessions', sessionId);
  await mkdir(sessionDir, { recursive: true });
  return sessionDir;
}

describe('stale state retirement is explicit, not automatic', () => {
  it('never mutates workflow projections without an explicit repair request', async () => {
    const root = await mkdtemp(join(tmpdir(), 'omx-no-auto-neutralize-'));
    const sessionDir = await seedSession(root, 'sess-current');
    const projectionPath = join(sessionDir, 'ralph-state.json');
    const original = JSON.stringify(activeRalphProjection());
    await writeFile(projectionPath, original);

    // The launch path no longer neutralizes anything, so the only way state
    // changes is an explicit operator action. Nothing has been requested here.
    assert.equal(await readFile(projectionPath, 'utf-8'), original);
    assert.equal(
      existsSync(join(root, '.omx', 'state', 'state-neutralized-0.21.json')),
      false,
      'the retired neutralizer must not leave a marker behind',
    );
  });

  it('preserves the current session scope when repair is requested explicitly', async () => {
    const root = await mkdtemp(join(tmpdir(), 'omx-repair-preserves-current-'));
    const sessionDir = await seedSession(root, 'sess-current');
    const currentProjection = join(sessionDir, 'ralph-state.json');
    const original = JSON.stringify(activeRalphProjection());
    await writeFile(currentProjection, original);

    const result = await repairStateProjections(root, { ...process.env, OMX_SESSION_ID: 'sess-current' });

    assert.ok(
      result.preserved.some((path) => path === currentProjection),
      `the current session projection must be preserved, saw ${JSON.stringify(result.preserved)}`,
    );
    assert.equal(
      result.archived.some((path) => path === currentProjection),
      false,
      'a valid current active projection must never be archived',
    );
    assert.equal(
      await readFile(currentProjection, 'utf-8'),
      original,
      'repair must not rewrite the preserved projection in place',
    );
  });

  it('archives a non-authoritative projection instead of rewriting it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'omx-repair-archives-stale-'));
    await seedSession(root, 'sess-current');
    const staleDir = join(root, '.omx', 'state', 'sessions', 'sess-abandoned');
    await mkdir(staleDir, { recursive: true });
    const stalePath = join(staleDir, 'ralph-state.json');
    const original = JSON.stringify(activeRalphProjection());
    await writeFile(stalePath, original);

    const result = await repairStateProjections(root, { ...process.env, OMX_SESSION_ID: 'sess-current' });

    // `archived` reports the archive destination, not the source path.
    const archivedDestination = result.archived.find((path) => path.endsWith(join('sess-abandoned', 'ralph-state.json')));
    assert.ok(
      archivedDestination,
      `the abandoned projection must be archived, saw ${JSON.stringify(result.archived)}`,
    );
    assert.match(archivedDestination, /[/\\]\.omx[/\\]archive[/\\]/);
    assert.equal(existsSync(stalePath), false, 'an archived projection is moved, not left behind');
    assert.equal(
      await readFile(archivedDestination, 'utf-8'),
      original,
      'archived bytes must be recoverable verbatim, not rewritten',
    );
  });
});
