import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { describe, it, type TestContext } from 'node:test';
import {
  applyDetachedTerminalExitStatus,
  buildDetachedSessionBootstrapSteps,
  DETACHED_LEADER_READY_TIMEOUT_MS,
  cleanupDetachedPreReportSession,
  cleanupDetachedHudPane,
  cleanupFinalizedDetachedHud,
  decodeDetachedLeaderPayload,
  describeDetachedLeaderFailure,
  publishDetachedReleaseMarker,
  parseDetachedLeaderPaneIdByPid,
  isDetachedReadyReportAuthorized,
  probeExactDetachedSessionExists,
  resolveDetachedAttachExitStatus,
} from '../index.js';
import { isRealTmuxAvailable, tmuxSessionExists, withTempTmuxSession } from '../../team/__tests__/tmux-test-fixture.js';
import type { TempTmuxSessionFixture } from '../../team/__tests__/tmux-test-fixture.js';

const TEST_TIMEOUT_MS = 45_000;
const POLL_INTERVAL_MS = 50;
const omxBin = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'dist', 'cli', 'omx.js');

interface DetachedLeaderReport {
  version: number;
  kind: string;
  nonce: string;
  sessionId: string;
  sessionName: string;
  leaderPid: number;
  finalized?: boolean;
  exitStatus?: number;
}

interface DetachedHudAuthority {
  paneId: string;
  panePid: number;
  sessionName: string;
  sessionId: string;
  sessionCreated: string;
  windowId: string;
  operationMarker: string;
}

function skipUnlessTmux(t: TestContext): boolean {
  if (process.platform === 'win32') {
    t.skip('detached tmux leader tests are not supported on win32');
    return false;
  }
  if (isRealTmuxAvailable()) return true;
  assert.equal(process.env.CI, undefined, 'CI must provide tmux for detached leader teardown regression tests');
  t.skip('tmux is not installed');
  return false;
}

async function poll<T>(description: string, predicate: () => Promise<T | undefined> | T | undefined, timeoutMs = TEST_TIMEOUT_MS): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await predicate();
    if (result !== undefined) return result;
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
  throw new Error(`timed out waiting for ${description}`);
}

async function readReportWhen(path: string, predicate: (report: DetachedLeaderReport) => boolean): Promise<DetachedLeaderReport> {
  return poll(`detached leader report at ${path}`, async () => {
    try {
      const report = JSON.parse(await readFile(path, 'utf-8')) as DetachedLeaderReport;
      return predicate(report) ? report : undefined;
    } catch {
      return undefined;
    }
  });
}

function paneExists(fixture: { run: (args: string[]) => string }, paneId: string): boolean {
  return fixture.run(['list-panes', '-a', '-F', '#{pane_id}']).split('\n').includes(paneId);
}

function createOwnedHud(fixture: TempTmuxSessionFixture, ownerId: string): DetachedHudAuthority {
  const operationMarker = randomUUID();
  const [paneId, panePidRaw, sessionName, sessionId, sessionCreated, windowId] = fixture.run([
    'split-window', '-d', '-P', '-F', '#{pane_id}\t#{pane_pid}\t#{session_name}\t#{session_id}\t#{session_created}\t#{window_id}',
    '-t', fixture.sessionName, `env OMX_DETACHED_HUD_OPERATION=${operationMarker} sleep 120`,
  ]).trim().split('\t');
  const panePid = Number(panePidRaw);
  assert.ok(paneId && sessionName && sessionId && sessionCreated && windowId);
  assert.equal(Number.isSafeInteger(panePid) && panePid > 0, true);
  fixture.run(['set-option', '-pq', '-t', paneId, '@omx_hud_owner', ownerId]);
  return { paneId, panePid, sessionName, sessionId, sessionCreated, windowId, operationMarker };
}

function assertProcessDead(pid: number): void {
  assert.throws(
    () => process.kill(pid, 0),
    (error: unknown) => (error as NodeJS.ErrnoException).code === 'ESRCH',
  );
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

/**
 * Remove a detached-leader working directory once nothing is still writing to it.
 *
 * Subtests that intentionally preserve the HUD pane leave `omx hud --watch` running
 * against `<wd>/.omx/state` on a 1s tick. Recursive removal races that writer:
 * `force` only suppresses ENOENT, so a file recreated mid-walk surfaces as
 * `ENOTEMPTY: directory not empty, rmdir '<wd>/.omx/state'`. Wait for the writer to
 * exit, then retry to absorb any in-flight tick.
 */
async function cleanupDetachedWorkdir(wd: string, hudPanePid?: number): Promise<void> {
  if (hudPanePid !== undefined) {
    const deadline = Date.now() + TEST_TIMEOUT_MS;
    while (processAlive(hudPanePid) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    }
    assertProcessDead(hudPanePid);
  }
  await rm(wd, { recursive: true, force: true, maxRetries: 10, retryDelay: POLL_INTERVAL_MS });
}

async function startDetachedLeader(
  fixture: {
    run: (args: string[]) => string;
  },
  wd: string,
  sessionName: string,
  sessionId: string,
  nonce: string,
  fakeChild: string,
): Promise<{ releaseMarkerPath: string; leaderPaneId: string; hud: DetachedHudAuthority }> {
  const releaseMarkerPath = join(wd, `${sessionId}.${nonce}.release`);
  const hudCmd = `${JSON.stringify(process.execPath)} ${JSON.stringify(omxBin)} hud --watch`;
  const steps = buildDetachedSessionBootstrapSteps(
    sessionName,
    wd,
    fakeChild,
    hudCmd,
    null,
    undefined,
    undefined,
    false,
    sessionId,
    undefined,
    undefined,
    undefined,
    process.env,
    undefined,
    undefined,
    undefined,
    releaseMarkerPath,
    omxBin,
  );
  const newSession = steps.find((step) => step.name === 'new-session');
  const tagSession = steps.find((step) => step.name === 'tag-session');
  const splitHud = steps.find((step) => step.name === 'split-and-capture-hud-pane');
  assert.ok(newSession);
  assert.ok(tagSession);
  assert.ok(splitHud);

  newSession.args.splice(
    -1,
    0,
    '-e', 'OMX_AUTO_UPDATE=0',
    '-e', 'OMX_NOTIFY_FALLBACK=0',
    '-e', 'OMX_HOOK_DERIVED_SIGNALS=0',
  );
  const leaderPaneId = fixture.run(newSession.args);
  fixture.run(tagSession.args);

  const operationMarker = randomUUID();
  const splitArgs = [...splitHud.args];
  splitArgs[splitArgs.length - 1] = `env OMX_DETACHED_HUD_OPERATION=${operationMarker} ${splitArgs.at(-1)}`;
  const splitFormatIndex = splitArgs.indexOf('-F');
  assert.ok(splitFormatIndex >= 0 && splitArgs[splitFormatIndex + 1] === '#{pane_id}');
  splitArgs[splitFormatIndex + 1] = '#{pane_id}\t#{pane_pid}\t#{session_name}\t#{session_id}\t#{session_created}\t#{window_id}\tRECEIPT';
  const splitReceipt = fixture.run(splitArgs).trim().split('\t');
  assert.equal(splitReceipt.length, 7, 'the HUD split must return the seven-field production receipt');
  const [paneId, panePidRaw, hudSessionName, hudSessionId, sessionCreated, windowId, observedReceipt] = splitReceipt;
  assert.match(observedReceipt ?? '', /^RECEIPT$/, 'the HUD split receipt must terminate with the literal receipt marker');
  const panePid = Number(panePidRaw);
  assert.equal(Number.isSafeInteger(panePid) && panePid > 0, true);
  assert.notEqual(windowId, '');
  // The production split sink tags the created HUD pane with the session owner
  // before any finalize step runs.
  fixture.run(['set-option', '-pq', '-t', paneId, '@omx_hud_owner', sessionId]);

  const ready = await readReportWhen(releaseMarkerPath, (report) => report.kind === 'ready');
  assert.equal(ready.nonce, nonce);
  assert.equal(ready.sessionId, sessionId);
  assert.equal(ready.sessionName, sessionName);
  assert.equal(Number.isSafeInteger(ready.leaderPid) && ready.leaderPid > 0, true);
  const hud = { paneId, panePid, sessionName: hudSessionName, sessionId: hudSessionId, sessionCreated, windowId, operationMarker };
  publishDetachedReleaseMarker(releaseMarkerPath, nonce, sessionId, sessionName, ready.leaderPid, hud);

  return { releaseMarkerPath, leaderPaneId, hud };
}

function writeChild(wd: string, body: string): string {
  const path = join(wd, 'fake-codex.sh');
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
  return path;
}

describe('detached leader HUD teardown', () => {
  it('keeps the detached readiness window above slow macOS prelaunch completion', () => {
    assert.equal(DETACHED_LEADER_READY_TIMEOUT_MS, 120_000);
  });

  it('preserves and validates shouldAttach across detached payload encode and decode', () => {
    const payload = {
      cwd: '/tmp/project',
      sessionName: 'omx-session',
      sessionId: 'omx-session-id',
      codexCmd: 'codex',
      preLaunchOptions: {
        enableNotifyFallbackAuthority: false,
        worktreeDirty: false,
        shouldAttach: false,
      },
    };
    const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
    assert.equal(decodeDetachedLeaderPayload(encoded).preLaunchOptions.shouldAttach, false);
    const invalid = Buffer.from(JSON.stringify({
      ...payload,
      preLaunchOptions: { ...payload.preLaunchOptions, shouldAttach: 'false' },
    })).toString('base64url');
    assert.throws(() => decodeDetachedLeaderPayload(invalid), /invalid detached leader payload/);
  });

  it('preserves bounded nested detached failure causes without control characters', () => {
    const failure = new AggregateError(
      [new Error('metadata bind denied'), new Error('session pointer unusable\nretry denied')],
      'leader finalization failed',
    );
    assert.equal(
      describeDetachedLeaderFailure(failure),
      'leader finalization failed: metadata bind denied: session pointer unusable retry denied',
    );
  });

  it('derives the detached leader pane from the live pane PID instead of inherited TMUX_PANE', () => {
    const snapshot = [
      '%1\t0\t111',
      '%2\t1\t222',
      '%3\t0\t333',
    ].join('\n');
    assert.equal(parseDetachedLeaderPaneIdByPid(snapshot, 333), '%3');
    assert.throws(() => parseDetachedLeaderPaneIdByPid(snapshot, 222), /pane identity is unavailable/);
    assert.throws(
      () => parseDetachedLeaderPaneIdByPid(`${snapshot}\n%4\t0\t333`, 333),
      /pane identity is unavailable/,
    );
  });

  it('authenticates normal detached and Hermes ready reports with separate authority contracts', () => {
    const report = {
      version: 1 as const,
      kind: 'ready' as const,
      nonce: 'nonce',
      sessionId: 'session',
      sessionName: 'name',
      paneId: '%9',
      leaderPid: 900,
    };
    const expected = {
      nonce: 'nonce',
      sessionId: 'session',
      sessionName: 'name',
      leaderPaneId: '%9',
      leaderPanePid: 901,
    };
    assert.equal(isDetachedReadyReportAuthorized(report, { ...expected, shouldAttach: true }), false);
    assert.equal(isDetachedReadyReportAuthorized(report, { ...expected, shouldAttach: false }), true);
    assert.equal(
      isDetachedReadyReportAuthorized({ ...report, paneId: '%8' }, { ...expected, shouldAttach: false }),
      false,
    );
  });

  it('cleans an exact retained dead pane without an owner tag and rejects changed topology', async (t) => {
    if (!skipUnlessTmux(t)) return;
    await withTempTmuxSession(async (fixture) => {
      fixture.run(['set-option', '-g', 'remain-on-exit', 'on']);
      const snapshot = fixture.run([
        'display-message', '-p', '-t', fixture.sessionName,
        '#{session_name}\t#{session_id}\t#{session_created}\t#{window_id}\t#{pane_id}\t#{pane_pid}',
      ]).split('\t');
      const [sessionName, sessionId, sessionCreated, windowId, paneId, panePidRaw] = snapshot;
      const panePid = Number(panePidRaw);
      if (!sessionName || !sessionId || !sessionCreated || !windowId || !paneId || !Number.isSafeInteger(panePid)) {
        throw new Error('invalid retained-pane topology fixture');
      }
      fixture.runResult(['unset-option', '-t', fixture.sessionName, '@omx_instance_id']);
      process.kill(panePid, 'SIGTERM');
      await poll('retained dead pane', () => fixture.run(['display-message', '-p', '-t', paneId, '#{pane_dead}']) === '1' ? true : undefined);
      const authority = {
        paneId, panePid, sessionName, sessionId, sessionCreated, windowId,
        windowIndex: '0', ownerId: 'missing-owner-tag',
      };
      assert.throws(
        () => cleanupDetachedPreReportSession({ ...authority, windowId: '@999999' }),
        /topology changed before cleanup/,
      );
      assert.equal(fixture.sessionExists(sessionName), true);
      cleanupDetachedPreReportSession(authority);
      await poll('pre-report session destruction', () => !fixture.sessionExists(sessionName) ? true : undefined);
    });
  });
  it('removes the proven HUD so the last leader pane closes the session without touching unrelated panes', async (t) => {
    if (!skipUnlessTmux(t)) return;
    await withTempTmuxSession(async (fixture) => {
      const [leaderPaneId, leaderPidRaw] = fixture.run([
        'display-message', '-p', '-t', fixture.sessionName, '#{pane_id}\t#{pane_pid}',
      ]).split('\t');
      const hud = createOwnedHud(fixture, 'owner-zero');
      if (!leaderPaneId) throw new Error('invalid HUD teardown fixture');
      cleanupDetachedHudPane(hud, 'owner-zero');
      await poll('proven HUD pane removal', () => !fixture.run(['list-panes', '-a', '-F', '#{pane_id}']).split('\n').includes(hud.paneId) ? true : undefined);
      process.kill(Number(leaderPidRaw), 'SIGTERM');
      await poll('last-pane session destruction', () => !fixture.sessionExists() ? true : undefined);
    });

    await withTempTmuxSession(async (fixture) => {
      const [, leaderPidRaw] = fixture.run([
        'display-message', '-p', '-t', fixture.sessionName, '#{pane_id}\t#{pane_pid}',
      ]).split('\t');
      const userPaneId = fixture.run([
        'split-window', '-d', '-P', '-F', '#{pane_id}', '-t', fixture.sessionName, 'sleep 120',
      ]);
      const staleHudProof = createOwnedHud(fixture, 'owner-user-pane');
      cleanupDetachedHudPane(staleHudProof, 'owner-user-pane');
      const replacementPaneId = fixture.run([
        'split-window', '-d', '-P', '-F', '#{pane_id}', '-t', fixture.sessionName, 'sleep 120',
      ]);
      // A stale proof must be an ordinary fail-closed preserve, never a throw.
      assert.doesNotThrow(() => cleanupDetachedHudPane(staleHudProof, 'owner-user-pane'));
      assert.equal(fixture.run(['display-message', '-p', '-t', replacementPaneId, '#{pane_id}']), replacementPaneId);
      process.kill(Number(leaderPidRaw), 'SIGTERM');
      await poll('unrelated pane survives leader exit', () => fixture.sessionExists() ? true : undefined);
      assert.equal(fixture.run(['display-message', '-p', '-t', userPaneId, '#{pane_id}']), userPaneId);
    });
  });

  it('treats a stale or missing HUD proof target as an ordinary preserved mismatch without destroying the server', async (t) => {
    if (!skipUnlessTmux(t)) return;
    // Stale proof after the proven HUD was already removed and the pane id was
    // replaced by a new pane. The stale `-t %N` target must resolve to an
    // ordinary fail-closed preserve result: no throw, no server/session loss,
    // and no harm to the replacement or foreign panes.
    await withTempTmuxSession(async (fixture) => {
      const [, leaderPidRaw] = fixture.run([
        'display-message', '-p', '-t', fixture.sessionName, '#{pane_id}\t#{pane_pid}',
      ]).split('\t');
      const userPaneId = fixture.run([
        'split-window', '-d', '-P', '-F', '#{pane_id}', '-t', fixture.sessionName, 'sleep 120',
      ]);
      const staleHudProof = createOwnedHud(fixture, 'stale-proof-owner');
      assert.equal(cleanupDetachedHudPane(staleHudProof, 'stale-proof-owner'), undefined);
      await poll('proven HUD removal', () => !paneExists(fixture, staleHudProof.paneId) ? true : undefined);
      const replacementPaneId = fixture.run([
        'split-window', '-d', '-P', '-F', '#{pane_id}', '-t', fixture.sessionName, 'sleep 120',
      ]);
      assert.doesNotThrow(() => cleanupDetachedHudPane(staleHudProof, 'stale-proof-owner'));
      assert.equal(paneExists(fixture, replacementPaneId), true, 'the replacement pane must survive a stale proof');
      assert.equal(fixture.sessionExists(), true, 'the private fixture session must survive a stale proof');
      assert.equal(fixture.run(['display-message', '-p', '-t', userPaneId, '#{pane_id}']), userPaneId);
      process.kill(Number(leaderPidRaw), 'SIGTERM');
    });

    // Missing proof target: the proof pane id no longer exists anywhere.
    await withTempTmuxSession(async (fixture) => {
      const missingProof = createOwnedHud(fixture, 'missing-proof-owner');
      assert.equal(cleanupDetachedHudPane(missingProof, 'missing-proof-owner'), undefined);
      await poll('proven HUD removal', () => !paneExists(fixture, missingProof.paneId) ? true : undefined);
      const ghostProof = { ...missingProof, paneId: '%999999' };
      assert.doesNotThrow(() => cleanupDetachedHudPane(ghostProof, 'missing-proof-owner'));
      assert.equal(fixture.sessionExists(), true, 'the private fixture session must survive a missing proof target');
    });
  });

  it('preserves the tmux server, leader, replacement pane, and foreign session across a stale HUD proof attack', async (t) => {
    if (!skipUnlessTmux(t)) return;
    const fixtureServer = await withTempTmuxSession(async (fixture) => {
      const [leaderPaneId, leaderPidRaw] = fixture.run([
        'display-message', '-p', '-t', fixture.sessionName, '#{pane_id}\t#{pane_pid}',
      ]).split('\t');
      const staleProof = createOwnedHud(fixture, 'attack-owner');
      // Remove the proven HUD and let its pane id be recycled by a replacement pane.
      assert.equal(cleanupDetachedHudPane(staleProof, 'attack-owner'), undefined);
      await poll('proven HUD removal', () => !paneExists(fixture, staleProof.paneId) ? true : undefined);
      const replacementPaneId = fixture.run([
        'split-window', '-d', '-P', '-F', '#{pane_id}', '-t', fixture.sessionName, 'sleep 120',
      ]);
      const foreignSessionName = `${fixture.sessionName}-foreign`;
      fixture.run(['new-session', '-d', '-s', foreignSessionName, '-c', fixture.sessionName, 'sleep 120']);
      // The stale proof must fail closed without killing the server, session, or panes.
      assert.doesNotThrow(() => cleanupDetachedHudPane(staleProof, 'attack-owner'));
      assert.equal(fixture.sessionExists(), true, 'leader session must survive');
      assert.equal(tmuxSessionExists(foreignSessionName, fixture.serverName), true, 'foreign session must survive');
      assert.equal(paneExists(fixture, leaderPaneId), true, 'leader pane must survive');
      assert.equal(paneExists(fixture, replacementPaneId), true, 'replacement pane must survive');
      // The server must still be reachable for ordinary commands after the attack.
      assert.ok(fixture.run(['list-sessions', '-F', '#{session_name}']).includes(fixture.sessionName));
      return fixture.serverName;
    });
    // Server liveness must persist past the fixture scope: the cleanup kill-server
    // in withTempTmuxSession proves termination is fixture-owned, not attack-owned.
    assert.ok(typeof fixtureServer === 'string');
  });

  it('removes only the matching bootstrap HUD after a finalized leader failure', async (t) => {
    if (!skipUnlessTmux(t)) return;
    await withTempTmuxSession(async (fixture) => {
      const ownerId = 'finalized-failure-owner';
      const expected = createOwnedHud(fixture, ownerId);
      assert.equal(cleanupFinalizedDetachedHud(expected, ownerId), true);
      await poll('bootstrap HUD removal', () => !paneExists(fixture, expected.paneId) ? true : undefined);
    });
  });

  it('preserves a bootstrap HUD when its proof or owner changes before finalized failure cleanup', async (t) => {
    if (!skipUnlessTmux(t)) return;
    const mutations: Array<readonly [string, (fixture: TempTmuxSessionFixture, proof: DetachedHudAuthority) => DetachedHudAuthority]> = [
      ['owner', (fixture, proof) => {
        fixture.run(['set-option', '-pq', '-t', proof.paneId, '@omx_hud_owner', 'foreign-owner']);
        return proof;
      }],
      ['pane PID', (_fixture, proof) => ({ ...proof, panePid: proof.panePid + 1 })],
      ['session creation', (_fixture, proof) => ({ ...proof, sessionCreated: `${Number(proof.sessionCreated) + 1}` })],
      ['window topology', (_fixture, proof) => ({ ...proof, windowId: '@999999' })],
      ['operation marker', (_fixture, proof) => ({ ...proof, operationMarker: randomUUID() })],
    ];
    for (const [name, mutate] of mutations) {
      await withTempTmuxSession(async (fixture) => {
        const ownerId = `finalized-failure-${name}`;
        const expected = createOwnedHud(fixture, ownerId);
        assert.equal(cleanupFinalizedDetachedHud(mutate(fixture, expected), ownerId), false, name);
        assert.equal(paneExists(fixture, expected.paneId), true, name);
      });
    }
  });


  it('tears down the proven HUD pane and session after a zero-status child exit', async (t) => {
    if (!skipUnlessTmux(t)) return;
    const wd = mkdtempSync(join(tmpdir(), 'omx-detached-leader-zero-'));
    try {
      await withTempTmuxSession(async (fixture) => {
        const sessionName = 'omx-detached-zero';
        const sessionId = 'detached-zero-session';
        const fakeChild = writeChild(wd, 'sleep 1\nexit 0');
        const started = await startDetachedLeader(fixture, wd, sessionName, sessionId, 'zero-nonce', fakeChild);
        const terminal = await readReportWhen(started.releaseMarkerPath, (report) => report.kind === 'terminal');
        assert.equal(terminal.finalized, true);
        assert.equal(terminal.exitStatus, 0);
        await poll('leader pane removal', () => !paneExists(fixture, started.leaderPaneId) ? true : undefined);
        await poll('HUD pane removal', () => !paneExists(fixture, started.hud.paneId) ? true : undefined);
        await poll('leader session destruction', () => !tmuxSessionExists(sessionName, fixture.serverName) ? true : undefined);
        await poll('HUD process exit', () => !processAlive(started.hud.panePid) ? true : undefined);
        assertProcessDead(started.hud.panePid);
        assert.equal(fixture.sessionExists(), true);
      });
    } finally {
      await cleanupDetachedWorkdir(wd);
    }
  });

  it('tears down the proven HUD pane and session after a nonzero child exit', async (t) => {
    if (!skipUnlessTmux(t)) return;
    const wd = mkdtempSync(join(tmpdir(), 'omx-detached-leader-nonzero-'));
    try {
      await withTempTmuxSession(async (fixture) => {
        const sessionName = 'omx-detached-nonzero';
        const sessionId = 'detached-nonzero-session';
        const fakeChild = writeChild(wd, 'sleep 1\nexit 7');
        const started = await startDetachedLeader(fixture, wd, sessionName, sessionId, 'nonzero-nonce', fakeChild);
        const terminal = await readReportWhen(started.releaseMarkerPath, (report) => report.kind === 'terminal');
        assert.equal(terminal.finalized, true);
        assert.equal(terminal.exitStatus, 7);
        await poll('leader pane removal', () => !paneExists(fixture, started.leaderPaneId) ? true : undefined);
        await poll('HUD pane removal', () => !paneExists(fixture, started.hud.paneId) ? true : undefined);
        await poll('leader session destruction', () => !tmuxSessionExists(sessionName, fixture.serverName) ? true : undefined);
        await poll('HUD process exit', () => !processAlive(started.hud.panePid) ? true : undefined);
        assertProcessDead(started.hud.panePid);
        assert.equal(fixture.sessionExists(), true);
      });
    } finally {
      await cleanupDetachedWorkdir(wd);
    }
  });

  it('preserves the HUD pane and session after signal-derived child death', async (t) => {
    if (!skipUnlessTmux(t)) return;
    const wd = mkdtempSync(join(tmpdir(), 'omx-detached-leader-signal-'));
    // This subtest deliberately preserves the HUD pane, so its `omx hud --watch`
    // is still writing `<wd>/.omx/state` when the test body returns.
    let hudPanePid: number | undefined;
    try {
      await withTempTmuxSession(async (fixture) => {
        const sessionName = 'omx-detached-signal';
        const sessionId = 'detached-signal-session';
        // Signal the direct child process regardless of /bin/sh -c exec behavior:
      // with exec-optimization $PPID is the leader (external-interrupt path);
      // without it, $PPID is the wrapped /bin/sh child itself (outcome.signal path).
      // Both are signal-derived exits where teardown must stay closed (exit 143).
      const fakeChild = writeChild(wd, 'sleep 1\nkill -TERM $PPID\nsleep 30');
        const started = await startDetachedLeader(fixture, wd, sessionName, sessionId, 'signal-nonce', fakeChild);
        hudPanePid = started.hud.panePid;
        const terminal = await readReportWhen(started.releaseMarkerPath, (report) => report.kind === 'terminal');
        assert.equal(terminal.finalized, true);
        assert.equal(terminal.exitStatus, 143);
        assert.equal(paneExists(fixture, started.hud.paneId), true);
        assert.equal(tmuxSessionExists(sessionName, fixture.serverName), true);
      });
    } finally {
      await cleanupDetachedWorkdir(wd, hudPanePid);
    }
  });

  it('removes only the proven HUD pane while preserving a foreign pane in the leader session', async (t) => {
    if (!skipUnlessTmux(t)) return;
    const wd = mkdtempSync(join(tmpdir(), 'omx-detached-leader-foreign-'));
    try {
      await withTempTmuxSession(async (fixture) => {
        const sessionName = 'omx-detached-foreign';
        const sessionId = 'detached-foreign-session';
        const fakeChild = writeChild(wd, 'sleep 1\nexit 0');
        const started = await startDetachedLeader(fixture, wd, sessionName, sessionId, 'foreign-nonce', fakeChild);
        const foreignPaneId = fixture.run([
          'split-window', '-d', '-P', '-F', '#{pane_id}', '-t', sessionName, '-c', wd, 'sleep 300',
        ]);
        const foreignPanePid = Number(fixture.run([
          'display-message', '-p', '-t', foreignPaneId, '#{pane_pid}',
        ]));
        const terminal = await readReportWhen(started.releaseMarkerPath, (report) => report.kind === 'terminal');
        assert.equal(terminal.exitStatus, 0);
        await poll('leader pane removal', () => !paneExists(fixture, started.leaderPaneId) ? true : undefined);
        await poll('HUD pane removal', () => !paneExists(fixture, started.hud.paneId) ? true : undefined);
        await poll('HUD process exit', () => !processAlive(started.hud.panePid) ? true : undefined);
        assertProcessDead(started.hud.panePid);
        assert.equal(paneExists(fixture, foreignPaneId), true);
        assert.doesNotThrow(() => process.kill(foreignPanePid, 0));
        assert.equal(tmuxSessionExists(sessionName, fixture.serverName), true);
        assert.equal(fixture.sessionExists(), true);
      });
    } finally {
      await cleanupDetachedWorkdir(wd);
    }
  });

  it('applies only a matching finalized terminal exit status', () => {
    const wd = mkdtempSync(join(tmpdir(), 'omx-detached-exit-status-'));
    const path = join(wd, 'marker.release');
    const previousExitCode = process.exitCode;
    try {
      writeFileSync(path, JSON.stringify({
        version: 1, kind: 'terminal', nonce: 'n', sessionId: 's', sessionName: 'sn', leaderPid: 123,
        finalized: true, exitStatus: 7,
      }));
      process.exitCode = undefined;
      assert.equal(applyDetachedTerminalExitStatus(path, { nonce: 'n', sessionId: 's', sessionName: 'sn', leaderPid: 123 }), true);
      assert.equal(process.exitCode, 7);

      process.exitCode = 19;
      assert.equal(applyDetachedTerminalExitStatus(path, { nonce: 'wrong', sessionId: 's', sessionName: 'sn', leaderPid: 123 }), false);
      assert.equal(process.exitCode, 19);

      writeFileSync(path, JSON.stringify({ version: 1, kind: 'failed', nonce: 'n', sessionId: 's', sessionName: 'sn', leaderPid: 123, finalized: true, exitStatus: 7 }));
      assert.equal(applyDetachedTerminalExitStatus(path, { nonce: 'n', sessionId: 's', sessionName: 'sn', leaderPid: 123 }), false);
      assert.equal(process.exitCode, 19);

      writeFileSync(path, JSON.stringify({ version: 1, kind: 'terminal', nonce: 'n', sessionId: 's', sessionName: 'sn', leaderPid: 123, finalized: true }));
      assert.equal(applyDetachedTerminalExitStatus(path, { nonce: 'n', sessionId: 's', sessionName: 'sn', leaderPid: 123 }), false);
      assert.equal(process.exitCode, 19);
    } finally {
      process.exitCode = previousExitCode;
      rmSync(wd, { recursive: true, force: true });
    }
  });

  it('publishes an optional HUD authority proof exactly', () => {
    const wd = mkdtempSync(join(tmpdir(), 'omx-detached-release-marker-'));
    const path = join(wd, 'marker.release');
    const hud = { paneId: '%1', panePid: 123, sessionName: 'session', sessionId: '$1', sessionCreated: '1', windowId: '@1', operationMarker: 'operation' };
    try {
      publishDetachedReleaseMarker(path, 'n', 's', 'sn', 456, hud);
      assert.deepEqual(JSON.parse(readFileSync(`${path}.release`, 'utf-8')), {
        version: 1, kind: 'release', nonce: 'n', sessionId: 's', sessionName: 'sn', leaderPid: 456, hud,
      });

      publishDetachedReleaseMarker(path, 'n', 's', 'sn', 456);
      const withoutHud = JSON.parse(readFileSync(`${path}.release`, 'utf-8')) as Record<string, unknown>;
      assert.equal(Object.hasOwn(withoutHud, 'hud'), false);
    } finally {
      rmSync(wd, { recursive: true, force: true });
    }
  });

  it('distinguishes destroyed-session protocol failure from manual detach', () => {
    const wd = mkdtempSync(join(tmpdir(), 'omx-detached-attach-resolution-'));
    const path = join(wd, 'marker.release');
    const expected = { nonce: 'n', sessionId: 's', sessionName: 'sn', leaderPid: 123 };
    const previousExitCode = process.exitCode;
    try {
      // Destroyed session + missing report: finalized status is mandatory -> failure.
      assert.equal(
        resolveDetachedAttachExitStatus(path, expected, { exactSessionExists: () => false }),
        'protocol-failure',
      );
      // Destroyed session + malformed report -> failure.
      writeFileSync(path, 'not json');
      assert.equal(
        resolveDetachedAttachExitStatus(path, expected, { exactSessionExists: () => false }),
        'protocol-failure',
      );
      // Exact owned session provably alive with no terminal report -> manual detach stays success.
      rmSync(path, { force: true });
      assert.equal(
        resolveDetachedAttachExitStatus(path, expected, { exactSessionExists: () => true }),
        'manual-detach',
      );
      // Ambiguous session query (tmux unreachable) fails closed without any mutation.
      assert.equal(
        resolveDetachedAttachExitStatus(path, expected, { exactSessionExists: () => undefined }),
        'protocol-failure',
      );
      // A valid finalized terminal report applies its status and never probes the session.
      writeFileSync(path, JSON.stringify({
        version: 1, kind: 'terminal', nonce: 'n', sessionId: 's', sessionName: 'sn', leaderPid: 123,
        finalized: true, exitStatus: 7,
      }));
      process.exitCode = undefined;
      assert.equal(
        resolveDetachedAttachExitStatus(path, expected, {
          exactSessionExists: () => { throw new Error('probe must not run when the status applies'); },
        }),
        'applied',
      );
      assert.equal(process.exitCode, 7);
    } finally {
      process.exitCode = previousExitCode;
      rmSync(wd, { recursive: true, force: true });
    }
  });

  it('probeExactDetachedSessionExists distinguishes live, retained-dead, and destroyed leader panes', async (t) => {
    if (!skipUnlessTmux(t)) return;
    await withTempTmuxSession(async (fixture) => {
      const sessionName = 'omx-probe-liveness';
      fixture.run(['new-session', '-d', '-s', sessionName, '-x', '80', '-y', '24', 'sleep 1', ';', 'set-option', 'remain-on-exit', 'on']);
      const paneId = fixture.run(['list-panes', '-t', sessionName, '-F', '#{pane_id}']).split('\n')[0]!;
      const fields = fixture.run([
        'display-message', '-p', '-t', paneId,
        '#{session_name}\t#{session_id}\t#{session_created}\t#{window_index}\t#{window_id}\t#{pane_id}\t#{pane_pid}',
      ]).split('\t');
      const authority = {
        paneId,
        panePid: Number(fields[6]),
        sessionName,
        sessionId: fields[1]!,
        sessionCreated: fields[2]!,
        windowIndex: fields[3]!,
        windowId: fields[4]!,
        ownerId: 'probe-owner',
      };
      assert.equal(probeExactDetachedSessionExists(authority), true, 'live leader pane reads as surviving session');
      await poll('leader pane death', () => {
        const dead = fixture.run(['display-message', '-p', '-t', paneId, '#{pane_dead}']);
        return dead === '1' ? true : undefined;
      });
      assert.equal(probeExactDetachedSessionExists(authority), false, 'retained dead pane (remain-on-exit) fails closed as not-alive');
      fixture.run(['kill-session', '-t', sessionName]);
      assert.equal(probeExactDetachedSessionExists(authority), undefined, 'destroyed session is ambiguous and fails closed');
    });
  });
});
