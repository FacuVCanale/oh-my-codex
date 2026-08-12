import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { dispatchCodexNativeHook } from "../codex-native-hook.js";

/**
 * Issue #3358 Ultragoal cancellation lifecycle, updated for #3497:
 * exact `omx cancel` remains an authority-decreasing PreToolUse deny path;
 * non-exact wrappers are not hard-locked by deleted workflow gates.
 */

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function fixture() {
  const cwd = await mkdtemp(join(tmpdir(), "omx-3358-"));
  const stateDir = join(cwd, ".omx", "state");
  const sessionId = "sess-3358";
  const threadId = "thread-3358";
  const sessionDir = join(stateDir, "sessions", sessionId);
  await mkdir(sessionDir, { recursive: true });
  await writeJson(join(stateDir, "session.json"), {
    session_id: sessionId,
    native_session_id: threadId,
    cwd,
  });
  await writeJson(join(sessionDir, "ultragoal-state.json"), {
    active: true,
    mode: "ultragoal",
    current_phase: "executing",
    session_id: sessionId,
    thread_id: threadId,
    workingDirectory: cwd,
  });
  await writeJson(join(sessionDir, "skill-active-state.json"), {
    active: true,
    skill: "ultragoal",
    phase: "executing",
    session_id: sessionId,
    thread_id: threadId,
    active_skills: [{
      active: true,
      skill: "ultragoal",
      phase: "executing",
      session_id: sessionId,
      thread_id: threadId,
    }],
  });
  return { cwd, stateDir, sessionDir, sessionId, threadId };
}

function preTool(f: Awaited<ReturnType<typeof fixture>>, command: string) {
  return dispatchCodexNativeHook({
    hook_event_name: "PreToolUse",
    cwd: f.cwd,
    session_id: f.sessionId,
    thread_id: f.threadId,
    tool_name: "Bash",
    tool_input: { command },
  }, { cwd: f.cwd });
}

describe("issue #3358 Ultragoal cancellation lifecycle (#3497)", () => {
  it("exact omx cancel remains a PreToolUse deny path for active ultragoal", async () => {
    const f = await fixture();
    try {
      const result = await preTool(f, "omx cancel --force");
      assert.equal(result.outputJson?.decision, "block");
      assert.match(
        JSON.stringify(result.outputJson),
        /cancelled_exact_session|invalid_command|session_binding|actor_authority|active_state/,
      );
    } finally {
      await rm(f.cwd, { recursive: true, force: true });
    }
  });

  it("does not hard-lock non-leading cancel wrappers after gate removal", async () => {
    const f = await fixture();
    try {
      const before = await readFile(join(f.sessionDir, "skill-active-state.json"), "utf8");
      const result = await preTool(f, "env omx cancel --force");
      assert.notEqual(result.outputJson?.decision, "block");
      assert.equal(await readFile(join(f.sessionDir, "skill-active-state.json"), "utf8"), before);
    } finally {
      await rm(f.cwd, { recursive: true, force: true });
    }
  });

  it("rejects invalid exact cancel grammar without terminalizing", async () => {
    const f = await fixture();
    try {
      const before = await readFile(join(f.sessionDir, "skill-active-state.json"), "utf8");
      const result = await preTool(f, "omx cancel --please");
      assert.equal(result.outputJson?.decision, "block");
      assert.match(JSON.stringify(result.outputJson), /invalid_command|actor_authority|active_state|session_binding/);
      assert.equal(await readFile(join(f.sessionDir, "skill-active-state.json"), "utf8"), before);
    } finally {
      await rm(f.cwd, { recursive: true, force: true });
    }
  });
});
