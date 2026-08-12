import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { dispatchCodexNativeHook } from "../codex-native-hook.js";
import { buildConductorPreToolUseWriteGuardOutput } from "../codex-native-hook.js";

/**
 * Issue #3481 conductor deadlock coverage, updated for #3497:
 * conductor PreToolUse write hard gates are deleted; ordinary path is not locked.
 */

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

describe("issue #3481 conductor deadlock / #3497 gate removal", () => {
  it("buildConductorPreToolUseWriteGuardOutput is a no-op after gate deletion", async () => {
    const out = await buildConductorPreToolUseWriteGuardOutput(
      { tool_name: "Edit", tool_input: { file_path: "src/x.ts" } },
      process.cwd(),
      join(process.cwd(), ".omx", "state"),
      "sess",
      process.cwd(),
    );
    assert.equal(out, null);
  });

  it("active conductor/ralph state does not hard-lock ordinary product writes", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omx-3481-"));
    try {
      const stateDir = join(cwd, ".omx", "state");
      const sessionId = "sess-3481";
      const threadId = "thread-3481";
      await mkdir(join(stateDir, "sessions", sessionId), { recursive: true });
      await writeJson(join(stateDir, "session.json"), {
        session_id: sessionId,
        native_session_id: threadId,
        cwd,
      });
      await writeJson(join(stateDir, "sessions", sessionId, "ralph-state.json"), {
        active: true,
        mode: "ralph",
        current_phase: "executing",
        session_id: sessionId,
      });
      await writeJson(join(stateDir, "sessions", sessionId, "skill-active-state.json"), {
        active: true,
        skill: "ralph",
        phase: "executing",
        session_id: sessionId,
        active_skills: [{ active: true, skill: "ralph", phase: "executing", session_id: sessionId }],
      });

      const result = await dispatchCodexNativeHook({
        hook_event_name: "PreToolUse",
        cwd,
        session_id: sessionId,
        thread_id: threadId,
        agent_id: threadId,
        tool_name: "Edit",
        tool_input: { file_path: "src/runtime.ts" },
      }, { cwd });

      assert.notEqual(result.outputJson?.decision, "block");
      assert.notEqual(
        (result.outputJson as { hookSpecificOutput?: { permissionDecision?: string } } | null)
          ?.hookSpecificOutput?.permissionDecision,
        "deny",
      );
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
