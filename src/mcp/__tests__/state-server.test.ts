import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

async function withAmbientTmuxEnv<T>(env: NodeJS.ProcessEnv, run: () => Promise<T>): Promise<T> {
  const previousTmux = process.env.TMUX;
  const previousTmuxPane = process.env.TMUX_PANE;
  const previousPath = process.env.PATH;

  if (typeof env.TMUX === 'string') process.env.TMUX = env.TMUX;
  else delete process.env.TMUX;
  if (typeof env.TMUX_PANE === 'string') process.env.TMUX_PANE = env.TMUX_PANE;
  else delete process.env.TMUX_PANE;
  if (typeof env.PATH === 'string') process.env.PATH = env.PATH;
  else if ('PATH' in env) delete process.env.PATH;

  try {
    return await run();
  } finally {
    if (typeof previousTmux === 'string') process.env.TMUX = previousTmux;
    else delete process.env.TMUX;
    if (typeof previousTmuxPane === 'string') process.env.TMUX_PANE = previousTmuxPane;
    else delete process.env.TMUX_PANE;
    if (typeof previousPath === 'string') process.env.PATH = previousPath;
    else delete process.env.PATH;
  }
}

async function createFakeTmuxBin(wd: string): Promise<string> {
  const fakeBin = join(wd, 'bin');
  await mkdir(fakeBin, { recursive: true });
  const tmuxPath = join(fakeBin, 'tmux');
  await writeFile(
    tmuxPath,
    `#!/usr/bin/env bash
set -eu
cmd="\${1:-}"
shift || true
if [[ "$cmd" == "display-message" ]]; then
  target=""
  format=""
  while (($#)); do
    case "$1" in
      -p) shift ;;
      -t) target="$2"; shift 2 ;;
      *) format="$1"; shift ;;
    esac
  done
  if [[ -z "$target" && "$format" == "#{pane_id}" ]]; then
    echo "%777"
    exit 0
  fi
  if [[ -z "$target" && "$format" == "#S" ]]; then
    echo "maintainer-default"
    exit 0
  fi
  if [[ "$target" == "%777" && "$format" == "#{pane_id}" ]]; then
    echo "%777"
    exit 0
  fi
  if [[ "$target" == "%777" && "$format" == "#S" ]]; then
    echo "maintainer-default"
    exit 0
  fi
fi
if [[ "$cmd" == "list-sessions" ]]; then
  echo "maintainer-default"
  exit 0
fi
exit 1
`,
  );
  await chmod(tmuxPath, 0o755);
  return fakeBin;
}

describe('state-server directory initialization', () => {



  it('does not auto-complete existing workflow state when tracked write validation fails', async () => {
    process.env.OMX_STATE_SERVER_DISABLE_AUTO_START = '1';
    const { handleStateToolCall } = await import('../state-server.js');

    const wd = await mkdtemp(join(tmpdir(), 'omx-state-server-validate-before-transition-'));
    try {
      await mkdir(join(wd, '.omx', 'state', 'sessions', 'sess-invalid'), { recursive: true });
      await writeFile(
        join(wd, '.omx', 'state', 'sessions', 'sess-invalid', 'ralplan-state.json'),
        JSON.stringify({ active: true, mode: 'ralplan', current_phase: 'planning' }, null, 2),
      );

      const denied = await handleStateToolCall({
        params: {
          name: 'state_write',
          arguments: {
            workingDirectory: wd,
            session_id: 'sess-invalid',
            mode: 'ralph',
            active: true,
            current_phase: 'definitely-invalid',
          },
        },
      }, { allowWriterTools: true });

      assert.equal(denied.isError, true);
      const body = JSON.parse(denied.content[0]?.text || '{}') as { error?: string };
      assert.match(body.error || '', /ralph\.current_phase/i);

      const ralplanState = JSON.parse(
        await readFile(join(wd, '.omx', 'state', 'sessions', 'sess-invalid', 'ralplan-state.json'), 'utf-8'),
      ) as Record<string, unknown>;
      assert.equal(ralplanState.active, true);
      assert.equal(ralplanState.current_phase, 'planning');
      assert.equal(existsSync(join(wd, '.omx', 'state', 'sessions', 'sess-invalid', 'ralph-state.json')), false);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('allows ultrawork overlap with any tracked mode', async () => {
    process.env.OMX_STATE_SERVER_DISABLE_AUTO_START = '1';
    const { handleStateToolCall } = await import('../state-server.js');

    const wd = await mkdtemp(join(tmpdir(), 'omx-state-server-ultrawork-any-'));
    try {
      const first = await handleStateToolCall({
        params: {
          name: 'state_write',
          arguments: {
            workingDirectory: wd,
            session_id: 'sess-ulw',
            mode: 'autopilot',
            active: true,
            current_phase: 'planning',
          },
        },
      }, { allowWriterTools: true });
      assert.equal(first.isError, undefined);

      const second = await handleStateToolCall({
        params: {
          name: 'state_write',
          arguments: {
            workingDirectory: wd,
            session_id: 'sess-ulw',
            mode: 'ultrawork',
            active: true,
            current_phase: 'planning',
          },
        },
      }, { allowWriterTools: true });
      assert.equal(second.isError, undefined);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('keeps session-scoped workflow states isolated across writes and clears', async () => {
    process.env.OMX_STATE_SERVER_DISABLE_AUTO_START = '1';
    const { handleStateToolCall } = await import('../state-server.js');

    const wd = await mkdtemp(join(tmpdir(), 'omx-state-server-session-isolation-'));
    try {
      const writeA = await handleStateToolCall({
        params: {
          name: 'state_write',
          arguments: {
            workingDirectory: wd,
            session_id: 'sess-a',
            mode: 'deep-interview',
            active: true,
            current_phase: 'interview-a',
          },
        },
      }, { allowWriterTools: true });
      assert.equal(writeA.isError, undefined);

      const writeB = await handleStateToolCall({
        params: {
          name: 'state_write',
          arguments: {
            workingDirectory: wd,
            session_id: 'sess-b',
            mode: 'ralph',
            active: true,
            iteration: 1,
            max_iterations: 3,
            current_phase: 'executing',
          },
        },
      }, { allowWriterTools: true });
      assert.equal(writeB.isError, undefined);

      await handleStateToolCall({
        params: {
          name: 'state_clear',
          arguments: {
            workingDirectory: wd,
            session_id: 'sess-b',
            mode: 'ralph',
          },
        },
      }, { allowWriterTools: true });

      const sessionAState = JSON.parse(
        await readFile(join(wd, '.omx', 'state', 'sessions', 'sess-a', 'deep-interview-state.json'), 'utf-8'),
      ) as Record<string, unknown>;
      assert.equal(sessionAState.active, true);
      assert.equal(sessionAState.current_phase, 'interview-a');

      const sessionACanonical = JSON.parse(
        await readFile(join(wd, '.omx', 'state', 'sessions', 'sess-a', 'skill-active-state.json'), 'utf-8'),
      ) as { active_skills?: Array<{ skill: string; session_id?: string }> };
      assert.deepEqual(
        sessionACanonical.active_skills?.map(({ skill, session_id }) => ({ skill, session_id })),
        [{ skill: 'deep-interview', session_id: 'sess-a' }],
      );
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('does not auto-complete session workflows from root-scoped workflow writes', async () => {
    process.env.OMX_STATE_SERVER_DISABLE_AUTO_START = '1';
    const { handleStateToolCall } = await import('../state-server.js');

    const wd = await mkdtemp(join(tmpdir(), 'omx-state-server-root-session-isolation-'));
    try {
      await handleStateToolCall({
        params: {
          name: 'state_write',
          arguments: {
            workingDirectory: wd,
            session_id: 'sess-interview',
            mode: 'deep-interview',
            active: true,
            current_phase: 'asking',
          },
        },
      }, { allowWriterTools: true });

      const rootWrite = await handleStateToolCall({
        params: {
          name: 'state_write',
          arguments: {
            workingDirectory: wd,
            mode: 'ralplan',
            active: true,
            current_phase: 'planning',
          },
        },
      }, { allowWriterTools: true });
      assert.equal(rootWrite.isError, undefined);

      const sessionState = JSON.parse(
        await readFile(join(wd, '.omx', 'state', 'sessions', 'sess-interview', 'deep-interview-state.json'), 'utf-8'),
      ) as Record<string, unknown>;
      assert.equal(sessionState.active, true);
      assert.equal(sessionState.current_phase, 'asking');
      assert.equal(sessionState.auto_completed_reason, undefined);

      const sessionCanonical = JSON.parse(
        await readFile(join(wd, '.omx', 'state', 'sessions', 'sess-interview', 'skill-active-state.json'), 'utf-8'),
      ) as { active_skills?: Array<{ skill: string; session_id?: string }> };
      assert.deepEqual(
        sessionCanonical.active_skills?.map(({ skill, session_id }) => ({ skill, session_id })),
        [{ skill: 'deep-interview', session_id: 'sess-interview' }],
      );

      const rootState = JSON.parse(await readFile(join(wd, '.omx', 'state', 'ralplan-state.json'), 'utf-8')) as Record<string, unknown>;
      assert.equal(rootState.active, true);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('keeps session canonical state when clearing the root scope without all_sessions', async () => {
    process.env.OMX_STATE_SERVER_DISABLE_AUTO_START = '1';
    const { handleStateToolCall } = await import('../state-server.js');

    const wd = await mkdtemp(join(tmpdir(), 'omx-state-server-root-clear-isolation-'));
    try {
      await handleStateToolCall({
        params: {
          name: 'state_write',
          arguments: {
            workingDirectory: wd,
            session_id: 'sess-keep',
            mode: 'deep-interview',
            active: true,
            current_phase: 'asking',
          },
        },
      }, { allowWriterTools: true });
      await handleStateToolCall({
        params: {
          name: 'state_write',
          arguments: {
            workingDirectory: wd,
            mode: 'deep-interview',
            active: true,
            current_phase: 'root-asking',
          },
        },
      }, { allowWriterTools: true });

      await handleStateToolCall({
        params: {
          name: 'state_clear',
          arguments: {
            workingDirectory: wd,
            mode: 'deep-interview',
          },
        },
      }, { allowWriterTools: true });

      assert.equal(existsSync(join(wd, '.omx', 'state', 'deep-interview-state.json')), false);
      const sessionState = JSON.parse(
        await readFile(join(wd, '.omx', 'state', 'sessions', 'sess-keep', 'deep-interview-state.json'), 'utf-8'),
      ) as Record<string, unknown>;
      assert.equal(sessionState.active, true);

      const sessionCanonical = JSON.parse(
        await readFile(join(wd, '.omx', 'state', 'sessions', 'sess-keep', 'skill-active-state.json'), 'utf-8'),
      ) as { active_skills?: Array<{ skill: string; session_id?: string }> };
      assert.deepEqual(
        sessionCanonical.active_skills?.map(({ skill, session_id }) => ({ skill, session_id })),
        [{ skill: 'deep-interview', session_id: 'sess-keep' }],
      );
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

});
