import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, type TestContext } from 'node:test';
import {
  buildDetachedSessionRollbackSteps,
  cleanupDetachedPreReportSession,
  detachedLeaderFailureErrorForTest,
  DetachedLaunchSafetyError,
  isDetachedSessionPointerAbortCarried,
  reportDetachedSessionPointerGuidance,
  type DetachedBootstrapReport,
} from '../index.js';
import { isRealTmuxAvailable, withTempTmuxSession } from '../../team/__tests__/tmux-test-fixture.js';

function skipUnlessTmux(t: TestContext): boolean {
  if (process.platform === 'win32') {
    t.skip('detached tmux leader tests are not supported on win32');
    return false;
  }
  if (isRealTmuxAvailable()) return true;
  assert.equal(process.env.CI, undefined, 'CI must provide tmux for #3578 detached diagnostics tests');
  t.skip('tmux is not installed');
  return false;
}

const emptyReport = (): DetachedBootstrapReport => ({ transitions: ['D0'], rollback: { attempted: [], failures: [] } });

describe('#3578 detached launch diagnostics', () => {
  describe('exact failing-step and cause reporting', () => {
    it('carries the exact bootstrap step name next to the coarse phase', () => {
      const cause = new Error('leader authority blocked tmux mutation history-limit');
      const stepError = new DetachedLaunchSafetyError('pane-id', cause, emptyReport(), 'tag-session');
      assert.equal(stepError.step, 'tag-session');
      assert.match(stepError.message, /during pane-id \(tag-session\)/);
      assert.match(stepError.message, /history-limit/);
      // The state machine's rewrap preserves the step across propagation.
      const rewrapped = new DetachedLaunchSafetyError(stepError.phase, stepError.cause, emptyReport(), stepError.step);
      assert.equal(rewrapped.step, 'tag-session');
    });

    it('keeps distinct step names for post-new-session mutations that previously collapsed into pane-id', () => {
      for (const step of ['tag-session', 'split-and-capture-hud-pane', 'register-resize-hook', 'schedule-delayed-resize']) {
        const error = new DetachedLaunchSafetyError('pane-id', new Error('boom'), emptyReport(), step);
        assert.equal(error.step, step);
        assert.match(error.message, new RegExp(`\\(${step.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\)`));
      }
      // new-session keeps the legacy inert-session phase and needs no step suffix.
      const inert = new DetachedLaunchSafetyError('inert-session', new Error('no pane id'), emptyReport(), 'new-session');
      assert.match(inert.message, /during inert-session \(new-session\)/);
    });

    it('renders the step only when it differs from the phase', () => {
      const withoutStep = new DetachedLaunchSafetyError('completion', new Error('timed out'), emptyReport());
      assert.equal(withoutStep.step, undefined);
      assert.doesNotMatch(withoutStep.message, /\(/);
      const report = JSON.parse(`{"phase":"pane-id","step":"split-and-capture-hud-pane","failure":"boom"}`);
      assert.equal(report.step, 'split-and-capture-hud-pane');
    });
  });

  describe('bounded abort-code propagation through AggregateError', () => {
    it('rebuilds the bounded abort marker from a validated failed report', () => {
      const carried = detachedLeaderFailureErrorForTest({
        error: 'Session pointer sess-live-owner conflicts with an active session; launch aborted',
        abortCode: 'session_pointer_owner_conflict',
      });
      assert.equal(isDetachedSessionPointerAbortCarried(carried), true);
      assert.equal((carried as { code?: string }).code, 'session_pointer_owner_conflict');

      const plain = detachedLeaderFailureErrorForTest({ error: 'detached leader setup failed' });
      assert.equal(isDetachedSessionPointerAbortCarried(plain), false);
    });

    it('finds the abort marker inside the D2 AggregateError wrap', () => {
      // executeDetachedLaunchStateMachine wraps completion failures as
      // AggregateError([leaderError]) before the outer launcher sees them.
      const leaderError = detachedLeaderFailureErrorForTest({ abortCode: 'session_pointer_unusable' });
      const wrapped = new AggregateError([leaderError], 'preLaunch session-instructions failed: unusable');
      assert.equal(isDetachedSessionPointerAbortCarried(wrapped), true);
      // Negative: ordinary nested errors never carry the marker.
      assert.equal(isDetachedSessionPointerAbortCarried(new AggregateError([new Error('x')], 'y')), false);
      assert.equal(isDetachedSessionPointerAbortCarried(new Error('session_pointer_owner_conflict')), false);
    });
  });

  describe('detached session-pointer guidance', () => {
    it('prints the ordinary OMX_ROOT guidance for a carried owner conflict, gated on cwd-default', () => {
      const wd = mkdtempSync(join(tmpdir(), 'omx-3578-guidance-'));
      const cwd = join(wd, 'checkout');
      try {
        const carried = detachedLeaderFailureErrorForTest({ abortCode: 'session_pointer_owner_conflict' });
        const wrapped = new AggregateError([carried], 'preLaunch session-instructions failed');
        const captured: string[] = [];
        const originalWrite = process.stderr.write.bind(process.stderr);
        (process.stderr as { write: (chunk: string) => boolean }).write = (chunk: string) => {
          captured.push(String(chunk));
          return true;
        };
        try {
          reportDetachedSessionPointerGuidance(wrapped, cwd);
        } finally {
          (process.stderr as { write: (chunk: string) => boolean }).write = originalWrite;
        }
        const output = captured.join('');
        assert.match(output, /concurrent conversations in this checkout require distinct user-specified OMX_ROOT values/);
        assert.match(output, /POSIX: OMX_ROOT="\$HOME\/\.omx\/instances\/second-conversation" omx/);
        assert.match(output, /OMX does not reroute or allocate one automatically/);
      } finally {
        rmSync(wd, { recursive: true, force: true });
      }
    });

    it('points stale/unusable pointers at doctor instead of OMX_ROOT rerouting', () => {
      const carried = detachedLeaderFailureErrorForTest({ abortCode: 'session_pointer_unusable' });
      const captured: string[] = [];
      const originalWrite = process.stderr.write.bind(process.stderr);
      (process.stderr as { write: (chunk: string) => boolean }).write = (chunk: string) => {
        captured.push(String(chunk));
        return true;
      };
      try {
        reportDetachedSessionPointerGuidance(carried, '/tmp');
      } finally {
        (process.stderr as { write: (chunk: string) => boolean }).write = originalWrite;
      }
      const output = captured.join('');
      assert.match(output, /run `omx doctor` for the exact pointer status/);
      assert.doesNotMatch(output, /distinct user-specified OMX_ROOT/);
      // Negative: an ordinary detached failure prints no pointer guidance at all.
      captured.length = 0;
      const restore = process.stderr.write.bind(process.stderr);
      (process.stderr as { write: (chunk: string) => boolean }).write = (chunk: string) => {
        captured.push(String(chunk));
        return true;
      };
      try {
        reportDetachedSessionPointerGuidance(new Error('detached leader readiness timed out'), '/tmp');
      } finally {
        (process.stderr as { write: (chunk: string) => boolean }).write = restore;
      }
      assert.equal(captured.length, 0);
    });
  });

  describe('identity-fenced cleanup when the leader pane is absent', () => {
    interface SessionAuthority {
      paneId: string;
      panePid: number;
      sessionName: string;
      sessionId: string;
      sessionCreated: string;
      windowId: string;
      windowIndex: string;
      ownerId: string;
    }

    const captureSession = (fixture: { run: (args: string[]) => string }, sessionName: string, ownerId: string): SessionAuthority => {
      const [paneId, panePidRaw, , sessionId, sessionCreated, windowIndex, windowId] = fixture.run([
        'list-panes', '-t', sessionName, '-F',
        '#{pane_id}\t#{pane_pid}\t#{session_name}\t#{session_id}\t#{session_created}\t#{window_index}\t#{window_id}',
      ]).trim().split('\t');
      assert.ok(paneId && panePidRaw && sessionId && sessionCreated && windowId);
      return {
        paneId: paneId!,
        panePid: Number(panePidRaw),
        sessionName,
        sessionId: sessionId!,
        sessionCreated: sessionCreated!,
        windowIndex: (windowIndex ?? '0')!,
        windowId: windowId!,
        ownerId,
      };
    };

    it('cleans up through the session fence after a normal leader exit removed the pane', async (t) => {
      if (!skipUnlessTmux(t)) return;
      await withTempTmuxSession(async (fixture) => {
        const sessionName = 'omx-3578-leader-gone';
        fixture.run(['new-session', '-d', '-s', sessionName, '-c', fixture.sessionName, 'sleep 5']);
        const hudPaneId = fixture.run([
          'split-window', '-d', '-P', '-F', '#{pane_id}', '-t', sessionName, 'sleep 300',
        ]);
        const authority = captureSession(fixture, sessionName, 'owner-3578-a');
        fixture.run(['set-option', '-t', sessionName, '@omx_instance_id', authority.ownerId]);
        // Normal leader exit with remain-on-exit off removes the leader pane; the
        // HUD-only session is exactly the leak #3578 reports.
        await new Promise((resolve) => setTimeout(resolve, 5_500));
        assert.equal(
          fixture.run(['list-panes', '-s', '-t', sessionName, '-F', '#{pane_id}']).split('\n').includes(authority.paneId),
          false,
          'fixture must reproduce the removed-leader-pane topology',
        );
        assert.equal(fixture.run(['list-panes', '-s', '-t', sessionName, '-F', '#{pane_id}']).split('\n').includes(hudPaneId!), true);
        cleanupDetachedPreReportSession(authority);
        await new Promise((resolve) => setTimeout(resolve, 300));
        // has-session exits 1 once the exact owned session is destroyed: the
        // leak #3578 reported is its continued survival, so non-zero is the pass.
        assert.notEqual(fixture.runResult(['has-session', '-t', sessionName]).status, 0, 'the exact owned HUD-only session must be destroyed');
      });
    });

    it('refuses cleanup when a replacement session reuses the exact session name (negative identity race)', async (t) => {
      if (!skipUnlessTmux(t)) return;
      await withTempTmuxSession(async (fixture) => {
        const sessionName = 'omx-3578-reuse-race';
        fixture.run(['new-session', '-d', '-s', sessionName, '-c', fixture.sessionName, 'sleep 5']);
        const authority = captureSession(fixture, sessionName, 'owner-3578-b');
        fixture.run(['set-option', '-t', sessionName, '@omx_instance_id', authority.ownerId]);
        await new Promise((resolve) => setTimeout(resolve, 5_500));
        // Race: a replacement session takes the same name with different
        // session_id/session_created and its own owner tag before cleanup runs.
        fixture.run(['new-session', '-d', '-s', sessionName, '-c', fixture.sessionName, 'sleep 300']);
        fixture.run(['set-option', '-t', sessionName, '@omx_instance_id', 'replacement-owner']);
        assert.throws(
          () => cleanupDetachedPreReportSession(authority),
          /topology changed before cleanup/,
          'a name-reusing replacement session must never be killed',
        );
        assert.equal(fixture.runResult(['has-session', '-t', sessionName]).status, 0, 'the replacement session must survive');
      });
    });

    it('refuses cleanup when the session identity matches but the owner tag is foreign (negative identity)', async (t) => {
      if (!skipUnlessTmux(t)) return;
      await withTempTmuxSession(async (fixture) => {
        const sessionName = 'omx-3578-foreign-owner';
        fixture.run(['new-session', '-d', '-s', sessionName, '-c', fixture.sessionName, 'sleep 5']);
        // A surviving HUD pane keeps the session alive after the leader pane is
        // gone, so cleanup must route through the session fence and be refused
        // there by the foreign owner tag.
        fixture.run(['split-window', '-d', '-P', '-F', '#{pane_id}', '-t', sessionName, 'sleep 300']);
        const authority = captureSession(fixture, sessionName, 'owner-3578-c');
        fixture.run(['set-option', '-t', sessionName, '@omx_instance_id', 'foreign-owner']);
        await new Promise((resolve) => setTimeout(resolve, 5_500));
        assert.throws(
          () => cleanupDetachedPreReportSession(authority),
          /topology changed before cleanup/,
          'a foreign owner tag must fail the session fence closed',
        );
        // The HUD-only session is deliberately preserved: identity could not be proven.
        const survivors = fixture.run(['list-panes', '-s', '-t', sessionName, '-F', '#{pane_id}']).trim().split('\n').filter(Boolean);
        assert.equal(survivors.length > 0, true, 'the unproven session must be preserved');
      });
    });

    it('keeps the rollback step builder targeting the named session only', () => {
      const steps = buildDetachedSessionRollbackSteps('omx-3578-target', null, null, null);
      const kill = steps.find((step) => step.name === 'kill-session');
      assert.ok(kill);
      assert.deepEqual(kill.args, ['kill-session', '-t', 'omx-3578-target']);
    });
  });
});
