import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { dispatchCodexNativeHook } from "../codex-native-hook.js";

/**
 * #3181 / #3194 role-intent native-hook e2e, updated for #3497:
 * documented-leader PreToolUse hard gate is deleted; ordinary path is not locked.
 */

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

describe("#3194 role-intent native-hook e2e (#3497)", () => {
  it("does not hard-deny role-intent Bash on PreToolUse after gate removal", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omx-3181-"));
    try {
      const stateDir = join(cwd, ".omx", "state");
      const sessionId = "sess-3181";
      await mkdir(join(stateDir, "sessions", sessionId), { recursive: true });
      await writeJson(join(stateDir, "session.json"), {
        session_id: sessionId,
        native_session_id: "thread-3181",
        cwd,
      });

      const result = await dispatchCodexNativeHook({
        hook_event_name: "PreToolUse",
        cwd,
        session_id: sessionId,
        thread_id: "thread-3181",
        source: "native",
        tool_name: "Bash",
        tool_input: {
          command: "omx state write --input '{\"mode\":\"ralplan\",\"active\":true}' --json",
        },
      }, { cwd });

      assert.notEqual(result.outputJson?.decision, "block");
      assert.doesNotMatch(JSON.stringify(result.outputJson ?? {}), /unsupported_documented_leader_proof/);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("UserPromptSubmit remains available for ordinary skill context injection", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omx-3181-prompt-"));
    try {
      const result = await dispatchCodexNativeHook({
        hook_event_name: "UserPromptSubmit",
        cwd,
        session_id: "sess-3181-prompt",
        source: "native",
        prompt: "implement a tiny fix without workflow keywords",
      }, { cwd });
      // May be null context or advisory triage; must not hard-lock.
      if (result.outputJson) {
        assert.notEqual(result.outputJson.decision, "block");
      }
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
