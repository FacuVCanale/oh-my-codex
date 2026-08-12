import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { dispatchCodexNativeHook } from "../codex-native-hook.js";
import { TEAM_TMUX_CAPABILITY_WARNING } from "../../hooks/native/capability-warnings.js";

/**
 * Issue #3311 originally hard-blocked standalone Ultragoal activation on Codex App
 * (native outside-tmux) because owner/tmux provenance was unreachable.
 *
 * Issue #3497 / epic #3491 C6 deletes that hard gate: ordinary path (including
 * ultragoal) must complete without PreToolUse locks on Codex App. Team remains a
 * capability warning only.
 */
async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true }).catch(() => {});
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function writeLeaderSessionFixture(
  stateDir: string,
  sessionId: string,
  leaderThreadId: string,
  cwd: string,
): Promise<void> {
  await mkdir(join(stateDir, "sessions", sessionId), { recursive: true });
  await writeJson(join(stateDir, "session.json"), {
    session_id: sessionId,
    native_session_id: leaderThreadId,
    cwd,
  });
  await writeJson(join(stateDir, "subagent-tracking.json"), {
    schemaVersion: 1,
    sessions: {
      [sessionId]: {
        session_id: sessionId,
        leader_thread_id: leaderThreadId,
        threads: {
          [leaderThreadId]: { thread_id: leaderThreadId, kind: "leader" },
        },
      },
    },
  });
}

function assertNotHardLocked(outputJson: Record<string, unknown> | null | undefined): void {
  if (!outputJson) return;
  assert.notEqual(outputJson.decision, "block");
  const permission = (outputJson.hookSpecificOutput as { permissionDecision?: string } | undefined)
    ?.permissionDecision;
  assert.notEqual(permission, "deny");
  assert.doesNotMatch(JSON.stringify(outputJson), /OMX-ULTRAGOAL-NO-OWNER/);
}

describe("issue #3311 / #3497 ultragoal native outside-tmux (ordinary path unlocked)", () => {
  const previousTmux = process.env.TMUX;
  const previousTmuxPane = process.env.TMUX_PANE;

  before(() => {
    delete process.env.TMUX;
    delete process.env.TMUX_PANE;
  });

  after(() => {
    if (previousTmux === undefined) delete process.env.TMUX;
    else process.env.TMUX = previousTmux;
    if (previousTmuxPane === undefined) delete process.env.TMUX_PANE;
    else process.env.TMUX_PANE = previousTmuxPane;
  });

  it("allows primary '$ultragoal' UserPromptSubmit activation on native App outside tmux", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omx-native-hook-3311-prompt-"));
    try {
      const result = await dispatchCodexNativeHook(
        {
          hook_event_name: "UserPromptSubmit",
          prompt: "$ultragoal implement a tiny fix",
          cwd,
          session_id: "sess-3311-prompt",
          source: "native",
        },
        { cwd },
      );
      assert.doesNotMatch(String(result.skillState?.transition_error ?? ""), /OMX-ULTRAGOAL-NO-OWNER/);
      assertNotHardLocked(result.outputJson as Record<string, unknown> | null);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("does not hard-block standalone-ultragoal Conductor activation on native App outside tmux (Bash state write)", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omx-native-hook-3311-bash-"));
    try {
      const stateDir = join(cwd, ".omx", "state");
      const sessionId = "sess-3311-bash-no-owner";
      const leaderThreadId = "thread-3311-bash-no-owner";
      await writeLeaderSessionFixture(stateDir, sessionId, leaderThreadId, cwd);

      const activation = JSON.stringify({
        mode: "ultragoal",
        active: true,
        state: { current_phase: "planning" },
      });
      const result = await dispatchCodexNativeHook(
        {
          hook_event_name: "PreToolUse",
          cwd,
          session_id: sessionId,
          thread_id: leaderThreadId,
          agent_id: leaderThreadId,
          source: "native",
          tool_name: "Bash",
          tool_input: { command: `omx state write --input '${activation}' --json` },
        },
        { cwd },
      );
      assertNotHardLocked(result.outputJson as Record<string, unknown> | null);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("does not hard-block standalone-ultragoal Conductor activation on native App outside tmux (structured state_write)", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omx-native-hook-3311-mcp-"));
    try {
      const stateDir = join(cwd, ".omx", "state");
      const sessionId = "sess-3311-mcp-no-owner";
      const leaderThreadId = "thread-3311-mcp-no-owner";
      await writeLeaderSessionFixture(stateDir, sessionId, leaderThreadId, cwd);

      const result = await dispatchCodexNativeHook(
        {
          hook_event_name: "PreToolUse",
          cwd,
          session_id: sessionId,
          thread_id: leaderThreadId,
          agent_id: leaderThreadId,
          source: "native",
          tool_name: "mcp__omx_state__state_write",
          tool_input: { mode: "ultragoal", active: true, state: { current_phase: "planning" } },
        },
        { cwd },
      );
      assertNotHardLocked(result.outputJson as Record<string, unknown> | null);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("ordinary Bash PreToolUse on Codex App outside tmux completes without deny", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omx-native-hook-3311-ordinary-"));
    try {
      const result = await dispatchCodexNativeHook(
        {
          hook_event_name: "PreToolUse",
          cwd,
          session_id: "sess-3311-ordinary",
          source: "native",
          tool_name: "Bash",
          tool_input: { command: "echo ordinary-path" },
        },
        { cwd },
      );
      assertNotHardLocked(result.outputJson as Record<string, unknown> | null);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("emits a team capability warning string for product docs / reuse", () => {
    assert.match(TEAM_TMUX_CAPABILITY_WARNING, /tmux/i);
    assert.match(TEAM_TMUX_CAPABILITY_WARNING, /Capability warning/i);
  });
});
