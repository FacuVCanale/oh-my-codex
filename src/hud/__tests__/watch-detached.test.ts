import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { runWatchMode } from '../index.js';
import type { HudFlags, HudRenderContext } from '../types.js';

const WATCH_FLAGS: HudFlags = {
  watch: true,
  json: false,
  tmux: false,
};

function emptyCtx(): HudRenderContext {
  return {
    version: null,
    gitBranch: null,
    ralph: null,
    ultrawork: null,
    autopilot: null,
    ralplan: null,
    deepInterview: null,
    autoresearch: null,
    ultraqa: null,
    team: null,
    metrics: null,
    hudNotify: null,
    session: null,
  };
}

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => {};
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

async function withTimeout(promise: Promise<void>, message: string, timeoutMs = 1000): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(message)), timeoutMs);
  });
  try {
    await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

afterEach(() => {
  process.exitCode = undefined;
});

describe('runWatchMode detached attachment gating (closes #3577)', () => {
  it('skips render-only work while detached but keeps the authority tick running', async () => {
    const writes: string[] = [];
    let stateReads = 0;
    let authorityCalls = 0;
    let attachmentQueries = 0;
    let sigintHandler: (() => void) | undefined;
    let timerTick: (() => void) | undefined;
    const secondAuthorityStarted = deferred();

    const promise = runWatchMode('/tmp', WATCH_FLAGS, {
      isTTY: true,
      env: {},
      isSessionAttachedFn: () => {
        attachmentQueries += 1;
        return false;
      },
      readAllStateFn: async () => {
        stateReads += 1;
        return emptyCtx();
      },
      readHudConfigFn: async () => ({ preset: 'focused', git: { display: 'repo-branch' }, statusLine: { preset: 'focused' } }),
      renderHudFn: () => 'frame',
      runAuthorityTickFn: async () => {
        authorityCalls += 1;
        if (authorityCalls === 2) secondAuthorityStarted.resolve();
      },
      writeStdout: (text) => { writes.push(text); },
      writeStderr: () => {},
      registerSigint: (handler) => { sigintHandler = handler; },
      setIntervalFn: (handler) => {
        timerTick = handler;
        return ({}) as ReturnType<typeof setInterval>;
      },
      clearIntervalFn: () => {},
    });

    await flush();
    assert.ok(timerTick, 'interval tick should be registered');
    timerTick?.();
    await withTimeout(secondAuthorityStarted.promise, 'second authority tick should run while detached');
    sigintHandler?.();
    await promise;

    // The very first frame renders unconditionally so an attached client (or a
    // first render before any detach) never sees an empty pane.
    assert.equal(stateReads, 1, 'detached ticks must not re-read HUD state');
    assert.equal(authorityCalls, 2, 'authority tick must keep running while detached');
    assert.ok(attachmentQueries >= 2, 'attachment must be queried each tick');
    assert.equal(writes.filter((chunk) => chunk.includes('frame')).length, 1, 'only the first frame may be written while detached');
  });

  it('renders immediately on the first tick after a client reattaches', async () => {
    const writes: string[] = [];
    let stateReads = 0;
    let sigintHandler: (() => void) | undefined;
    let timerTick: (() => void) | undefined;
    const thirdReadStarted = deferred();
    const secondReadDone = deferred();

    let attached = false;
    const promise = runWatchMode('/tmp', WATCH_FLAGS, {
      isTTY: true,
      env: {},
      isSessionAttachedFn: () => attached,
      readAllStateFn: async () => {
        stateReads += 1;
        if (stateReads === 2) secondReadDone.resolve();
        if (stateReads === 3) thirdReadStarted.resolve();
        return emptyCtx();
      },
      readHudConfigFn: async () => ({ preset: 'focused', git: { display: 'repo-branch' }, statusLine: { preset: 'focused' } }),
      renderHudFn: () => `frame:${stateReads}`,
      runAuthorityTickFn: async () => {},
      writeStdout: (text) => { writes.push(text); },
      writeStderr: () => {},
      registerSigint: (handler) => { sigintHandler = handler; },
      setIntervalFn: (handler) => {
        timerTick = handler;
        return ({}) as ReturnType<typeof setInterval>;
      },
      clearIntervalFn: () => {},
    });

    await flush();
    // Detached tick: suppressed render.
    attached = false;
    timerTick?.();
    await flush();
    assert.equal(stateReads, 1, 'detached tick must not read state');

    // Reattach: the next tick renders immediately with fresh state.
    attached = true;
    timerTick?.();
    await withTimeout(secondReadDone.promise, 'reattached tick must render immediately');
    sigintHandler?.();
    await promise;

    assert.equal(stateReads, 2);
    assert.ok(writes.some((chunk) => chunk.includes('frame:2')), 'reattached frame must be written');
  });

  it('keeps rendering every tick while attached (no behavior change when attached)', async () => {
    const writes: string[] = [];
    let stateReads = 0;
    let sigintHandler: (() => void) | undefined;
    let timerTick: (() => void) | undefined;
    const thirdReadStarted = deferred();

    const promise = runWatchMode('/tmp', WATCH_FLAGS, {
      isTTY: true,
      env: {},
      isSessionAttachedFn: () => true,
      readAllStateFn: async () => {
        stateReads += 1;
        if (stateReads === 3) thirdReadStarted.resolve();
        return emptyCtx();
      },
      readHudConfigFn: async () => ({ preset: 'focused', git: { display: 'repo-branch' }, statusLine: { preset: 'focused' } }),
      renderHudFn: () => 'frame',
      runAuthorityTickFn: async () => {},
      writeStdout: (text) => { writes.push(text); },
      writeStderr: () => {},
      registerSigint: (handler) => { sigintHandler = handler; },
      setIntervalFn: (handler) => {
        timerTick = handler;
        return ({}) as ReturnType<typeof setInterval>;
      },
      clearIntervalFn: () => {},
    });

    await flush();
    timerTick?.();
    timerTick?.();
    await withTimeout(thirdReadStarted.promise, 'attached ticks must keep rendering');
    sigintHandler?.();
    await promise;

    assert.equal(stateReads, 3);
    assert.equal(writes.filter((chunk) => chunk.includes('frame')).length, 3);
  });

  it('fails open and renders when the attachment probe throws', async () => {
    const writes: string[] = [];
    let stateReads = 0;
    let sigintHandler: (() => void) | undefined;
    let timerTick: (() => void) | undefined;
    const secondReadStarted = deferred();

    const promise = runWatchMode('/tmp', WATCH_FLAGS, {
      isTTY: true,
      env: {},
      isSessionAttachedFn: () => {
        throw new Error('no server running');
      },
      readAllStateFn: async () => {
        stateReads += 1;
        if (stateReads === 2) secondReadStarted.resolve();
        return emptyCtx();
      },
      readHudConfigFn: async () => ({ preset: 'focused', git: { display: 'repo-branch' }, statusLine: { preset: 'focused' } }),
      renderHudFn: () => 'frame',
      runAuthorityTickFn: async () => {},
      writeStdout: (text) => { writes.push(text); },
      writeStderr: () => {},
      registerSigint: (handler) => { sigintHandler = handler; },
      setIntervalFn: (handler) => {
        timerTick = handler;
        return ({}) as ReturnType<typeof setInterval>;
      },
      clearIntervalFn: () => {},
    });

    await flush();
    timerTick?.();
    await withTimeout(secondReadStarted.promise, 'failing probe must fall back to rendering');
    sigintHandler?.();
    await promise;

    assert.equal(stateReads, 2);
  });

  it('does not clear the terminal or write control sequences while detached', async () => {
    const writes: string[] = [];
    let sigintHandler: (() => void) | undefined;
    let timerTick: (() => void) | undefined;
    const secondAuthority = deferred();

    let authorityCalls = 0;
    const promise = runWatchMode('/tmp', WATCH_FLAGS, {
      isTTY: true,
      env: {},
      isSessionAttachedFn: () => false,
      readAllStateFn: async () => emptyCtx(),
      readHudConfigFn: async () => ({ preset: 'focused', git: { display: 'repo-branch' }, statusLine: { preset: 'focused' } }),
      renderHudFn: () => 'frame',
      runAuthorityTickFn: async () => {
        authorityCalls += 1;
        if (authorityCalls === 2) secondAuthority.resolve();
      },
      writeStdout: (text) => { writes.push(text); },
      writeStderr: () => {},
      registerSigint: (handler) => { sigintHandler = handler; },
      setIntervalFn: (handler) => {
        timerTick = handler;
        return ({}) as ReturnType<typeof setInterval>;
      },
      clearIntervalFn: () => {},
    });

    await flush();
    timerTick?.();
    await withTimeout(secondAuthority.promise, 'second detached tick should complete');
    sigintHandler?.();
    await promise;

    // Only the initial hide-cursor + first-frame clear, never a per-tick '\x1b[H' repaint.
    assert.equal(writes.filter((chunk) => chunk === '\x1b[H').length, 0, 'detached ticks must not repaint');
  });
  it('binds the default attachment probe to the injected env, not inherited process.env', async () => {
    // Regression for the review blocker on PR #3579: the default
    // isSessionAttachedFn used the inherited process.env, so a test (or any
    // caller) that injects env: {} while running inside tmux still consulted
    // the ambient TMUX/TMUX_PANE and could suppress renders. The default probe
    // must see only dependencies.env.
    const previousTmux = process.env.TMUX;
    const previousTmuxPane = process.env.TMUX_PANE;
    let stateReads = 0;
    let sigintHandler: (() => void) | undefined;
    let timerTick: (() => void) | undefined;
    const secondReadDone = deferred();

    process.env.TMUX = '/tmp/tmux-1000/default,1,0';
    process.env.TMUX_PANE = '%7';

    let promise: Promise<void>;
    try {
      promise = runWatchMode('/tmp', WATCH_FLAGS, {
        isTTY: true,
        // Injected env has no TMUX: the default probe must treat this as
        // attached even though process.env still carries tmux variables.
        env: {},
        readAllStateFn: async () => {
          stateReads += 1;
          if (stateReads === 2) secondReadDone.resolve();
          return emptyCtx();
        },
        readHudConfigFn: async () => ({ preset: 'focused', git: { display: 'repo-branch' }, statusLine: { preset: 'focused' } }),
        renderHudFn: () => 'frame',
        runAuthorityTickFn: async () => {},
        writeStdout: () => {},
        writeStderr: () => {},
        registerSigint: (handler) => { sigintHandler = handler; },
        setIntervalFn: (handler) => {
          timerTick = handler;
          return ({}) as ReturnType<typeof setInterval>;
        },
        clearIntervalFn: () => {},
      });

      await flush();
      assert.ok(timerTick, 'interval tick should be registered');
      // Second tick must render: injected env has no TMUX, so the default
      // probe must answer "attached" regardless of the ambient tmux env.
      timerTick?.();
      await withTimeout(secondReadDone.promise, 'injected env (no TMUX) must keep rendering despite inherited tmux env');
      sigintHandler?.();
      await promise;
    } finally {
      if (typeof previousTmux === 'string') process.env.TMUX = previousTmux;
      else delete process.env.TMUX;
      if (typeof previousTmuxPane === 'string') process.env.TMUX_PANE = previousTmuxPane;
      else delete process.env.TMUX_PANE;
    }

    assert.equal(stateReads, 2, 'ticks under an injected non-tmux env must keep rendering');
  });

  it('suppresses detached renders through the injected env when it describes tmux', async () => {
    // The mirror case: an injected env that DOES describe tmux must drive
    // suppression, proving the default probe reads dependencies.env (and not
    // merely "always attached because tests run without ambient tmux").
    const execStubHome = process.env.HOME;
    let attachmentProbes = 0;
    let stateReads = 0;
    let sigintHandler: (() => void) | undefined;
    let timerTick: (() => void) | undefined;
    const secondAuthority = deferred();
    let authorityCalls = 0;

    // Point PATH at a fake tmux that answers session_attached=0 for any pane,
    // so the default probe (which shells out to tmux) observes "detached".
    const fakeBin = await mkdtemp(join(tmpdir(), 'omx-hud-env-bind-'));
    const tmuxPath = join(fakeBin, 'tmux');
    await writeFile(tmuxPath, '#!/bin/sh\nif [ "$1" = "display-message" ]; then printf \'0\\n\'; exit 0; fi\nexit 0\n');
    await chmod(tmuxPath, 0o755);
    const previousPath = process.env.PATH;

    let promise: Promise<void>;
    try {
      process.env.PATH = `${fakeBin}${delimiter}${previousPath ?? ''}`;
      // Track probe executions by observing state reads: suppressed ticks do
      // not read state, so the only way tick 2 completes without a second
      // read is a detached answer from the injected env.
      promise = runWatchMode('/tmp', WATCH_FLAGS, {
        isTTY: true,
        env: { TMUX: '/tmp/tmux-1000/default,1,0', TMUX_PANE: '%7', CI: '1', PATH: process.env.PATH, HOME: execStubHome ?? '' },
        readAllStateFn: async () => {
          stateReads += 1;
          return emptyCtx();
        },
        readHudConfigFn: async () => ({ preset: 'focused', git: { display: 'repo-branch' }, statusLine: { preset: 'focused' } }),
        renderHudFn: () => 'frame',
        runAuthorityTickFn: async () => {
          authorityCalls += 1;
          attachmentProbes += 1;
          if (authorityCalls === 2) secondAuthority.resolve();
        },
        writeStdout: () => {},
        writeStderr: () => {},
        registerSigint: (handler) => { sigintHandler = handler; },
        setIntervalFn: (handler) => {
          timerTick = handler;
          return ({}) as ReturnType<typeof setInterval>;
        },
        clearIntervalFn: () => {},
      });

      await flush();
      assert.ok(timerTick, 'interval tick should be registered');
      timerTick?.();
      await withTimeout(secondAuthority.promise, 'second detached tick should complete without a state read');
      sigintHandler?.();
      await promise;
    } finally {
      process.env.PATH = previousPath;
      await rm(fakeBin, { recursive: true, force: true });
    }

    assert.equal(stateReads, 1, 'detached ticks under an injected tmux env must not re-read HUD state');
    assert.ok(attachmentProbes >= 2, 'authority tick must keep running while detached');
  });
});
