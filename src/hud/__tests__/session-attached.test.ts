import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { execFileSync } from 'node:child_process';
import { isHudWatchSessionAttached } from '../session-attached.js';
import { isRealTmuxAvailable, withTempTmuxSession } from '../../team/__tests__/tmux-test-fixture.js';

describe('isHudWatchSessionAttached', () => {
  it('treats a non-tmux environment as attached (fail-open)', () => {
    assert.equal(isHudWatchSessionAttached({ env: {}, execTmuxSync: () => '0\n' }), true);
    assert.equal(isHudWatchSessionAttached({ env: { TMUX: '' }, execTmuxSync: () => '0\n' }), true);
  });

  it('queries session attachment through the pane id from the environment', () => {
    const seenArgv: string[][] = [];
    const attached = isHudWatchSessionAttached({
      env: { TMUX: '/tmp/tmux-1000/default,1,0', TMUX_PANE: '%7' },
      execTmuxSync: (args) => {
        seenArgv.push(args);
        return '1\n';
      },
    });
    assert.equal(attached, true);
    assert.deepEqual(seenArgv, [['display-message', '-p', '-t', '%7', '#{session_attached}']]);

    const detached = isHudWatchSessionAttached({
      env: { TMUX: '/tmp/tmux-1000/default,1,0', TMUX_PANE: '%7' },
      execTmuxSync: () => '0\n',
    });
    assert.equal(detached, false);
  });

  it('falls back to the active pane when TMUX_PANE is missing', () => {
    const seenArgv: string[][] = [];
    const attached = isHudWatchSessionAttached({
      env: { TMUX: '/tmp/tmux-1000/default,1,0', TMUX_PANE: '' },
      execTmuxSync: (args) => {
        seenArgv.push(args);
        return '0\n';
      },
    });
    assert.equal(attached, false);
    assert.deepEqual(seenArgv, [['display-message', '-p', '-t', '', '#{session_attached}']]);
  });

  it('fails open when the tmux query throws', () => {
    assert.equal(
      isHudWatchSessionAttached({
        env: { TMUX: '/tmp/tmux-1000/default,1,0', TMUX_PANE: '%7' },
        execTmuxSync: () => {
          throw new Error('no server running');
        },
      }),
      true,
    );
    assert.equal(
      isHudWatchSessionAttached({
        env: { TMUX: '/tmp/tmux-1000/default,1,0' },
        execTmuxSync: () => {
          throw new Error('no server running');
        },
      }),
      true,
    );
  });

  it('treats a malformed attachment answer as attached (fail-open)', () => {
    assert.equal(
      isHudWatchSessionAttached({
        env: { TMUX: '/tmp/tmux-1000/default,1,0', TMUX_PANE: '%7' },
        execTmuxSync: () => '',
      }),
      true,
    );
    assert.equal(
      isHudWatchSessionAttached({
        env: { TMUX: '/tmp/tmux-1000/default,1,0', TMUX_PANE: '%7' },
        execTmuxSync: () => 'garbage',
      }),
      true,
    );
  });

  it('answers attachment from a real detached private tmux session', async (t) => {
    if (!isRealTmuxAvailable()) {
      t.skip('tmux is not available');
      return;
    }
    await withTempTmuxSession(async (fixture) => {
      const detachedBefore = execFileSync('tmux', [
        '-L', fixture.serverName, '-f', '/dev/null',
        'display-message', '-p', '-t', fixture.leaderPaneId, '#{session_attached}',
      ], { encoding: 'utf-8' }).trim();
      assert.equal(detachedBefore, '0', 'fixture session must start detached');

      const attachedViaEnv = isHudWatchSessionAttached({
        env: { TMUX: fixture.env.TMUX, TMUX_PANE: fixture.leaderPaneId },
      });
      assert.equal(attachedViaEnv, false, 'detached session must report not attached');
    });
  });
});
