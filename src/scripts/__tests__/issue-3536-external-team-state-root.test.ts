import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dispatchCodexNativeHook } from "../codex-native-hook.js";
import { sanitizeNativeHookOutput } from "../../hooks/native/pre-tool-use-advisory.js";

/**
 * Issue #3536: a verified Team worker using an external OMX state root with no
 * singleton session.json must not be rejected by the generic Conductor
 * policy-root guard, while every mismatch and protected-state write stays
 * denied. These tests exercise the effective dispatch output plus the native
 * hook adapter sanitizer (what Codex actually consumes), not only internal
 * classifiers.
 */

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, JSON.stringify(value, null, 2));
}

const WORKER_ENV_KEYS = [
  "TMUX",
  "TMUX_PANE",
  "OMX_TEAM_INTERNAL_WORKER",
  "OMX_TEAM_WORKER",
  "OMX_TEAM_STATE_ROOT",
  "OMX_TEAM_LEADER_CWD",
] as const;

interface WorkerFixture {
  root: string;
  leaderCwd: string;
  stateRoot: string;
  workerCwd: string;
  teamName: string;
  workerName: string;
  paneId: string;
}

async function createExternalRootWorkerFixture(): Promise<WorkerFixture> {
  const root = realpathSync(await mkdtemp(join(tmpdir(), "omx-3536-hook-")));
  const leaderCwd = join(root, "leader");
  const stateRoot = join(root, "external", ".omx", "state");
  const teamName = "ext-hook-team";
  const workerName = "worker-1";
  const paneId = "%78";
  const workerCwd = join(leaderCwd, ".omx", "team", teamName, "worktrees", workerName);
  await mkdir(workerCwd, { recursive: true });
  // External root has state (sessions/) but deliberately no singleton session.json.
  await mkdir(join(stateRoot, "sessions"), { recursive: true });
  const teamRoot = join(stateRoot, "team", teamName);
  await writeJson(join(teamRoot, "workers", workerName, "identity.json"), {
    name: workerName,
    index: 1,
    role: "executor",
    assigned_tasks: ["1"],
    pane_id: paneId,
    worktree_path: workerCwd,
    team_state_root: stateRoot,
  });
  const metadata = {
    name: teamName,
    leader_cwd: leaderCwd,
    team_state_root: stateRoot,
    leader_pane_id: "%42",
    workers: [{ name: workerName, pane_id: paneId, worktree_path: workerCwd, team_state_root: stateRoot }],
  };
  await writeJson(join(teamRoot, "manifest.v2.json"), metadata);
  await writeJson(join(teamRoot, "config.json"), metadata);
  return { root, leaderCwd, stateRoot, workerCwd, teamName, workerName, paneId };
}

function withWorkerEnv<T>(fixture: WorkerFixture, overrides: Record<string, string>, run: () => Promise<T>): Promise<T> {
  const saved: Record<string, string | undefined> = {};
  for (const key of WORKER_ENV_KEYS) saved[key] = process.env[key];
  for (const key of WORKER_ENV_KEYS) delete process.env[key];
  Object.assign(process.env, {
    TMUX: "1",
    TMUX_PANE: fixture.paneId,
    OMX_TEAM_INTERNAL_WORKER: `${fixture.teamName}/${fixture.workerName}`,
    OMX_TEAM_WORKER: `${fixture.teamName}/${fixture.workerName}`,
    OMX_TEAM_STATE_ROOT: fixture.stateRoot,
    OMX_TEAM_LEADER_CWD: fixture.leaderCwd,
    ...overrides,
  });
  return run().finally(() => {
    for (const key of WORKER_ENV_KEYS) {
      if (typeof saved[key] === "string") process.env[key] = saved[key];
      else delete process.env[key];
    }
  });
}

function assertNoEffectiveDeny(output: Record<string, unknown> | null, label: string): void {
  const sanitized = sanitizeNativeHookOutput("PreToolUse", output);
  const text = JSON.stringify(sanitized ?? {});
  assert.equal(sanitized?.decision, undefined, `${label}: adapter must not emit a hard decision`);
  assert.doesNotMatch(text, /PROVENANCE_DENIED/, `${label}: adapter effective output must not deny`);
  assert.notEqual(
    (sanitized?.hookSpecificOutput as Record<string, unknown> | undefined)?.permissionDecision,
    "deny",
    `${label}: adapter effective output must not be a permission deny`,
  );
}

describe("issue #3536 external Team state root worker authorization", () => {
  it("verified worker with external root and no singleton session.json can mutate a delegated product file", async () => {
    const fixture = await createExternalRootWorkerFixture();
    try {
      await withWorkerEnv(fixture, {}, async () => {
        const result = await dispatchCodexNativeHook({
          hook_event_name: "PreToolUse",
          cwd: fixture.workerCwd,
          session_id: "sess-3536-product-write",
          tool_name: "Write",
          tool_input: { file_path: join(fixture.workerCwd, "src", "feature.ts"), content: "export const x = 1;\n" },
        }, { cwd: fixture.workerCwd });
        assertNoEffectiveDeny(result.outputJson, "product write");
      });
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("verified worker product Bash write is not denied by the policy-root guard", async () => {
    const fixture = await createExternalRootWorkerFixture();
    try {
      await withWorkerEnv(fixture, {}, async () => {
        const result = await dispatchCodexNativeHook({
          hook_event_name: "PreToolUse",
          cwd: fixture.workerCwd,
          session_id: "sess-3536-bash-write",
          tool_name: "Bash",
          tool_input: { command: "printf 'ok\\n' > src/feature.ts" },
        }, { cwd: fixture.workerCwd });
        assertNoEffectiveDeny(result.outputJson, "bash product write");
      });
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("verified worker is not granted authority over protected team metadata", async () => {
    const fixture = await createExternalRootWorkerFixture();
    try {
      await withWorkerEnv(fixture, {}, async () => {
        for (const target of [
          join(fixture.stateRoot, "team", fixture.teamName, "config.json"),
          join(fixture.stateRoot, "team", fixture.teamName, "manifest.v2.json"),
          join(fixture.stateRoot, "team", fixture.teamName, "workers", fixture.workerName, "identity.json"),
        ]) {
          const result = await dispatchCodexNativeHook({
            hook_event_name: "PreToolUse",
            cwd: fixture.workerCwd,
            session_id: "sess-3536-protected",
            tool_name: "Write",
            tool_input: { file_path: target, content: "{}" },
          }, { cwd: fixture.workerCwd });
          const sanitized = sanitizeNativeHookOutput("PreToolUse", result.outputJson);
          // The current authority model never affirmatively permits protected
          // OMX orchestration metadata writes for a Team worker.
          assert.notEqual(
            (sanitized?.hookSpecificOutput as Record<string, unknown> | undefined)?.permissionDecision,
            "allow",
            `protected target must not be permitted: ${target}`,
          );
        }
      });
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("unverified worker with an external root stays fail-closed", async () => {
    const fixture = await createExternalRootWorkerFixture();
    try {
      // Pane identity mismatch: the declared worker cannot pass verification.
      await withWorkerEnv(fixture, { TMUX_PANE: "%99" }, async () => {
        const result = await dispatchCodexNativeHook({
          hook_event_name: "PreToolUse",
          cwd: fixture.workerCwd,
          session_id: "sess-3536-unverified",
          tool_name: "Write",
          tool_input: { file_path: join(fixture.workerCwd, "src", "evil.ts"), content: "x" },
        }, { cwd: fixture.workerCwd });
        const sanitized = sanitizeNativeHookOutput("PreToolUse", result.outputJson);
        assert.notEqual(
          (sanitized?.hookSpecificOutput as Record<string, unknown> | undefined)?.permissionDecision,
          "allow",
          "unverified worker must not gain write authority",
        );
      });
      // Foreign state root: no verified binding may form.
      await withWorkerEnv(fixture, { OMX_TEAM_STATE_ROOT: join(fixture.root, "foreign") }, async () => {
        const result = await dispatchCodexNativeHook({
          hook_event_name: "PreToolUse",
          cwd: fixture.workerCwd,
          session_id: "sess-3536-foreign-root",
          tool_name: "Write",
          tool_input: { file_path: join(fixture.workerCwd, "src", "evil.ts"), content: "x" },
        }, { cwd: fixture.workerCwd });
        const sanitized = sanitizeNativeHookOutput("PreToolUse", result.outputJson);
        assert.notEqual(
          (sanitized?.hookSpecificOutput as Record<string, unknown> | undefined)?.permissionDecision,
          "allow",
          "foreign-root worker must not gain write authority",
        );
      });
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });
});
