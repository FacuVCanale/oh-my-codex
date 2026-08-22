import assert from "node:assert/strict";
import { realpathSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { describe, it } from "node:test";

import { dispatchCodexNativeHook } from "../codex-native-hook.js";
import { normalizeSkillActiveState, syncSkillStateFromTurn } from "../notify-hook/auto-nudge.js";

/**
 * Issue #3358 Ultragoal cancellation lifecycle, updated for #3497:
 * exact `omx cancel` remains an authority-decreasing PreToolUse deny path;
 * non-exact wrappers are not hard-locked by deleted workflow gates.
 */

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function withTrustedWorkspaceOmxCli<T>(cwd: string, run: () => Promise<T>): Promise<T> {
  const binDir = join(cwd, "node_modules", ".bin");
  await mkdir(binDir, { recursive: true });
  await symlink(realpathSync(resolve(process.cwd(), "dist", "cli", "omx.js")), join(binDir, "omx"));
  const inherited = Object.fromEntries(
    ["PATH", "OMX_ROOT", "OMX_STATE_ROOT", "OMX_TEAM_STATE_ROOT", "OMX_SESSION_ID"]
      .map((name) => [name, process.env[name]]),
  );
  process.env.PATH = `${binDir}:${dirname(process.execPath)}:/usr/bin:/bin`;
  delete process.env.OMX_ROOT;
  delete process.env.OMX_STATE_ROOT;
  delete process.env.OMX_TEAM_STATE_ROOT;
  delete process.env.OMX_SESSION_ID;
  try {
    return await run();
  } finally {
    for (const [name, value] of Object.entries(inherited)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
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
  await writeJson(join(stateDir, "subagent-tracking.json"), {
    schemaVersion: 1,
    sessions: {
      [sessionId]: {
        session_id: sessionId,
        leader_thread_id: threadId,
        threads: { [threadId]: { thread_id: threadId, kind: "leader" } },
      },
    },
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
    session_id: f.threadId,
    thread_id: f.threadId,
    agent_id: f.threadId,
    tool_name: "Bash",
    tool_input: { command },
  }, { cwd: f.cwd });
}

describe("issue #3358 Ultragoal cancellation lifecycle (#3497)", () => {
  it("exact omx cancel remains a PreToolUse deny path for active ultragoal", async () => {
    const f = await fixture();
    try {
      const result = await withTrustedWorkspaceOmxCli(f.cwd, () => preTool(f, "omx cancel --force"));
      assert.equal(result.outputJson?.decision, "block");
      assert.match(
        JSON.stringify(result.outputJson),
        /cancelled_exact_session|invalid_command|session_binding|actor_authority|active_state/,
      );
    } finally {
      await rm(f.cwd, { recursive: true, force: true });
    }
  });

  it("cancels after notify preserves attached-tmux dual-session identity", async () => {
    const f = await fixture();
    try {
      const skillPath = join(f.sessionDir, "skill-active-state.json");
      await syncSkillStateFromTurn(f.stateDir, {
        cwd: f.cwd,
        "last-assistant-message": "Implementation continues.",
      }, f.sessionId, {
        targetSessionId: f.sessionId,
        ownerCodexSessionId: f.sessionId,
        allowedOwnerCodexSessionIds: [f.sessionId, f.threadId],
        allowedStorageSessionIds: [f.sessionId, f.threadId],
        targetRelation: "pointer-alias",
        thread: { kind: "root-or-drift" },
        legacyAdoption: "deny",
        globalSideEffects: "allow",
      });
      const afterNotify = JSON.parse(await readFile(skillPath, "utf8"));
      assert.equal(afterNotify.session_id, f.sessionId);
      assert.equal(afterNotify.thread_id, f.threadId);
      assert.equal(afterNotify.active_skills.length, 1);
      assert.equal(afterNotify.owner_codex_session_id, f.sessionId);

      const result = await withTrustedWorkspaceOmxCli(f.cwd, () => preTool(f, "omx cancel --force"));
      assert.equal(result.outputJson?.decision, "block");
      assert.match(JSON.stringify(result.outputJson), /cancelled_exact_session/);

      const skill = JSON.parse(await readFile(skillPath, "utf8"));
      const ultragoal = JSON.parse(await readFile(join(f.sessionDir, "ultragoal-state.json"), "utf8"));
      assert.equal(skill.active, false);
      assert.equal(ultragoal.active, false);
    } finally {
      await rm(f.cwd, { recursive: true, force: true });
    }
  });

  it("keeps foreign notify owners denied without changing lifecycle state", async () => {
    const f = await fixture();
    try {
      const skillPath = join(f.sessionDir, "skill-active-state.json");
      const ultragoalPath = join(f.sessionDir, "ultragoal-state.json");
      const stored = JSON.parse(await readFile(skillPath, "utf8"));
      await writeJson(skillPath, normalizeSkillActiveState({
        ...stored,
        owner_codex_session_id: "foreign-owner",
      }));
      const beforeSkill = await readFile(skillPath, "utf8");
      const beforeUltragoal = await readFile(ultragoalPath, "utf8");

      const result = await withTrustedWorkspaceOmxCli(f.cwd, () => preTool(f, "omx cancel --force"));
      assert.equal(result.outputJson?.decision, "block");
      assert.match(JSON.stringify(result.outputJson), /active_state/);
      assert.equal(await readFile(skillPath, "utf8"), beforeSkill);
      assert.equal(await readFile(ultragoalPath, "utf8"), beforeUltragoal);
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
      const result = await withTrustedWorkspaceOmxCli(f.cwd, () => preTool(f, "omx cancel --please"));
      assert.equal(result.outputJson?.decision, "block");
      assert.match(JSON.stringify(result.outputJson), /invalid_command|actor_authority|active_state|session_binding/);
      assert.equal(await readFile(join(f.sessionDir, "skill-active-state.json"), "utf8"), before);
    } finally {
      await rm(f.cwd, { recursive: true, force: true });
    }
  });
});
