import assert from "node:assert/strict";
import { chmod, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { describe, it } from "node:test";
import { dispatchCodexNativeHook } from "../codex-native-hook.js";

async function json(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(value, null, 2));
}

async function fixture(sessionId = "session-hook-cancel") {
  const cwd = await mkdtemp(join(tmpdir(), "omx-3293-hook-cancel-"));
  const stateDir = join(cwd, ".omx", "state");
  const threadId = `thread-${sessionId}`;
  const sessionDir = join(stateDir, "sessions", sessionId);
  await json(join(stateDir, "session.json"), { session_id: sessionId, cwd, leader_thread_id: threadId });
  await json(join(stateDir, "subagent-tracking.json"), { schemaVersion: 1, sessions: { [sessionId]: { session_id: sessionId, leader_thread_id: threadId, threads: { [threadId]: { thread_id: threadId, kind: "leader" } } } } });
  await json(join(sessionDir, "autopilot-state.json"), { active: true, mode: "autopilot", current_phase: "deep-interview", session_id: sessionId, thread_id: threadId, workingDirectory: cwd });
  await json(join(sessionDir, "skill-active-state.json"), { active: true, skill: "autopilot", phase: "deep-interview", session_id: sessionId, thread_id: threadId, active_skills: [{ active: true, skill: "autopilot", phase: "deep-interview", session_id: sessionId, thread_id: threadId }] });
  return { cwd, stateDir, sessionDir, sessionId, threadId };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

function preTool(f: Fixture, command: string, overrides: Record<string, unknown> = {}) {
  return dispatchCodexNativeHook({ hook_event_name: "PreToolUse", cwd: f.cwd, session_id: f.sessionId, thread_id: f.threadId, agent_id: f.threadId, tool_name: "Bash", tool_input: { command }, ...overrides }, { cwd: f.cwd });
}

function stop(f: Fixture) {
  return dispatchCodexNativeHook({ hook_event_name: "Stop", cwd: f.cwd, session_id: f.sessionId, thread_id: f.threadId }, { cwd: f.cwd });
}

function assertValueFreeDenial(result: Awaited<ReturnType<typeof preTool>>, f: Fixture, stateContent: string, label: string): void {
  assert.equal(result.outputJson?.decision, "block", label);
  const rendered = JSON.stringify(result.outputJson);
  for (const secret of [f.cwd, f.sessionId, stateContent]) assert.equal(rendered.includes(secret), false, `${label}: diagnostic leaked a value`);
}

async function withEnv<T>(values: Record<string, string | undefined>, run: () => Promise<T>): Promise<T> {
  const before = new Map(Object.keys(values).map((name) => [name, process.env[name]]));
  try {
    for (const [name, value] of Object.entries(values)) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
    return await run();
  } finally {
    for (const [name, value] of before) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
  }
}

async function denialFixture(command: string, mutate?: (f: Fixture) => Promise<void>, payload?: Record<string, unknown>) {
  const f = await fixture();
  try {
    if (mutate) await mutate(f);
    const stateContent = await readFile(join(f.sessionDir, "autopilot-state.json"), "utf8");
    const result = await preTool(f, command, payload);
    assertValueFreeDenial(result, f, stateContent, command);
  } finally { await rm(f.cwd, { recursive: true, force: true }); }
}

describe("issue #3293 hook-owned cancellation", () => {
  it("handles bare deep-interview cancellation, terminalizes both files, and does not execute Bash", async () => {
    const f = await fixture();
    try {
      const sentinel = join(f.cwd, "plugin-sentinel");
      await mkdir(join(f.cwd, ".omx", "hooks"), { recursive: true });
      await writeFile(join(f.cwd, ".omx", "hooks", "sentinel.mjs"), `import { writeFile } from 'node:fs/promises'; await writeFile(${JSON.stringify(sentinel)}, 'ran');`);
      const result = await preTool(f, "omx cancel");
      assert.equal(result.outputJson?.decision, "block");
      assert.match(JSON.stringify(result.outputJson), /cancelled_exact_session/);
      assert.equal(JSON.parse(await readFile(join(f.sessionDir, "autopilot-state.json"), "utf8")).active, false);
      assert.equal(JSON.parse(await readFile(join(f.sessionDir, "skill-active-state.json"), "utf8")).active, false);
      await assert.rejects(readFile(sentinel));
    } finally { await rm(f.cwd, { recursive: true, force: true }); }
  });

  it("stops repeatedly without continuation, reactivation, or terminal-byte changes", async () => {
    const f = await fixture();
    try {
      await preTool(f, "omx cancel");
      const paths = [join(f.sessionDir, "autopilot-state.json"), join(f.sessionDir, "skill-active-state.json")];
      const terminal = await Promise.all(paths.map((path) => readFile(path)));
      assert.equal((await stop(f)).outputJson, null);
      assert.equal((await stop(f)).outputJson, null);
      assert.deepEqual(await Promise.all(paths.map((path) => readFile(path))), terminal);
      assert.equal(JSON.parse(terminal[0].toString()).active, false);
    } finally { await rm(f.cwd, { recursive: true, force: true }); }
  });

  it("terminalizes only the exact session", async () => {
    const f = await fixture();
    try {
      const otherId = "session-other";
      const otherDir = join(f.stateDir, "sessions", otherId);
      const otherAutopilot = { active: true, mode: "autopilot", current_phase: "deep-interview", session_id: otherId, thread_id: "thread-other", workingDirectory: f.cwd };
      const otherSkill = { active: true, skill: "autopilot", phase: "deep-interview", session_id: otherId, thread_id: "thread-other" };
      await json(join(otherDir, "autopilot-state.json"), otherAutopilot);
      await json(join(otherDir, "skill-active-state.json"), otherSkill);
      const before = await Promise.all([readFile(join(otherDir, "autopilot-state.json")), readFile(join(otherDir, "skill-active-state.json"))]);
      await preTool(f, "omx cancel");
      assert.deepEqual(await Promise.all([readFile(join(otherDir, "autopilot-state.json")), readFile(join(otherDir, "skill-active-state.json"))]), before);
    } finally { await rm(f.cwd, { recursive: true, force: true }); }
  });

  it("fails closed for cancellation and Stop when a prepared journal exists", async () => {
    const f = await fixture();
    try {
      await json(join(f.sessionDir, ".hook-cancel-transaction.json"), { phase: "prepared", session_id: f.sessionId });
      const content = await readFile(join(f.sessionDir, "autopilot-state.json"), "utf8");
      assertValueFreeDenial(await preTool(f, "omx cancel"), f, content, "prepared cancellation");
      const stopped = await stop(f);
      assert.equal(stopped.outputJson?.decision, "block");
      const rendered = JSON.stringify(stopped.outputJson);
      for (const secret of [f.cwd, f.sessionId, content]) assert.equal(rendered.includes(secret), false);
    } finally { await rm(f.cwd, { recursive: true, force: true }); }
  });

  it("denies a fully forged public-hook caller because no executable trust can be forged", async () => {
    const f = await fixture();
    try {
      const attacker = join(f.cwd, "attacker-bin");
      await mkdir(attacker); await writeFile(join(attacker, "omx"), "#!/bin/sh\nexit 0\n"); await chmod(join(attacker, "omx"), 0o755);
      await withEnv({ PATH: attacker }, async () => {
        const content = await readFile(join(f.sessionDir, "autopilot-state.json"), "utf8");
        const result = await preTool(f, "omx cancel", { thread_id: "unbound-attacker", agent_id: "unbound-attacker" });
        assertValueFreeDenial(result, f, content, "fully forged public hook");
      });
    } finally { await rm(f.cwd, { recursive: true, force: true }); }
  });


  // #3497: PreToolUse is advisory-only except exact authority-decreasing `omx cancel`.
  // Former "hostile wrapper/lookalike" hard denies relied on deleted planning/conductor gates.
  it("still intercepts exact omx cancel as authority-decreasing deny", async () => {
    const f = await fixture();
    try {
      const result = await preTool(f, "omx cancel");
      assert.equal(result.outputJson?.decision, "block");
      assert.match(JSON.stringify(result.outputJson), /cancelled_exact_session/);
    } finally { await rm(f.cwd, { recursive: true, force: true }); }
  });

  it("does not hard-lock non-exact cancel wrappers after gate removal", async () => {
    const f = await fixture();
    try {
      // Leading exact `omx cancel` still intercepts (and rejects non-exact grammar as invalid_command).
      // Non-leading wrappers are ordinary Bash under advisory-only PreToolUse.
      for (const command of [
        "env omx cancel",
        "FOO=1 omx cancel",
        "$(omx) cancel",
        "`omx` cancel",
        "./omx cancel",
        "node --loader attacker.mjs omx cancel",
      ]) {
        const result = await preTool(f, command);
        assert.notEqual(result.outputJson?.decision, "block", command);
      }
      const exactHostile = await preTool(f, "omx cancel; rm -rf /");
      assert.equal(exactHostile.outputJson?.decision, "block");
      assert.match(JSON.stringify(exactHostile.outputJson), /invalid_command/);
    } finally { await rm(f.cwd, { recursive: true, force: true }); }
  });

  it("denies exact omx cancel when payload session identity is foreign", async () => {
    const f = await fixture();
    try {
      const stateContent = await readFile(join(f.sessionDir, "autopilot-state.json"), "utf8");
      const result = await preTool(f, "omx cancel", { session_id: "other-session", sessionId: "other-session" });
      // May deny session_binding / active_state, or not match exact session — must not silently terminalize foreign id.
      assert.equal(await readFile(join(f.sessionDir, "autopilot-state.json"), "utf8"), stateContent);
      if (result.outputJson?.decision === "block") {
        assert.match(JSON.stringify(result.outputJson), /session_binding|active_state|actor_authority|invalid_command|cancelled_exact_session/);
      }
    } finally { await rm(f.cwd, { recursive: true, force: true }); }
  });

  it("R-4 documents payload-bound identity and ambient same-euid target-root selection", async () => {
    const source = await readFile(resolve(process.cwd(), "src/scripts/codex-native-hook.ts"), "utf8");
    assert.match(source, /identity matching is payload-bound while target-root\s+\/\/ selection remains ambient and same-euid trusted/);
  });
});
