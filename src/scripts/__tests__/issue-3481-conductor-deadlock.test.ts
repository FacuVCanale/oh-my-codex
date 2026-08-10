import assert from "node:assert/strict";
import { realpathSync } from "node:fs";
import {
	chmod,
	mkdir,
	mkdtemp,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, it } from "node:test";
import { dispatchCodexNativeHook } from "../codex-native-hook.js";

// Regression coverage for OMX #3481: under an active Main-root Conductor state
// the root is (correctly) prohibited from editing source/product/plan directly,
// but every authorized delegation/orchestration/recovery/read-only path must
// remain reachable. The reported 0.20.5 deadlock blocked all of them at once.
// This suite proves the minimum contract: direct root writes stay denied, the
// static Team implementation lane and typed native delegation spawn stay
// available on a positively-supported surface, bounded orchestration and
// session-bound `omx state` mutations stay recognized, representative
// read-only diagnostics stay available, and denial wording reports the
// detected capability instead of a fixed upstream version.

async function writeJson(path: string, value: unknown): Promise<void> {
	await mkdir(dirname(path), { recursive: true }).catch(() => {});
	await writeFile(path, JSON.stringify(value, null, 2));
}

async function writeLeaderSessionFixture(
	stateDir: string,
	sessionId: string,
	leaderThreadId: string,
	cwd: string,
): Promise<void> {
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

async function writeActiveUltragoalConductorState(
	stateDir: string,
	sessionId: string,
	phase: string,
): Promise<void> {
	await writeJson(
		join(stateDir, "sessions", sessionId, "skill-active-state.json"),
		{
			active: true,
			skill: "ultragoal",
			phase,
			session_id: sessionId,
			active_skills: [
				{ skill: "ultragoal", phase, active: true, session_id: sessionId },
			],
		},
	);
	await writeJson(
		join(stateDir, "sessions", sessionId, "ultragoal-state.json"),
		{
			active: true,
			mode: "ultragoal",
			current_phase: phase,
			session_id: sessionId,
			workingDirectory: process.env.OMX_ROOT ?? "",
		},
	);
}

interface ConductorFixture {
	cwd: string;
	stateDir: string;
	sessionId: string;
	leaderThreadId: string;
	absoluteOmx: string;
}

async function withConductorFixture<T>(
	run: (fixture: ConductorFixture) => Promise<T>,
): Promise<T> {
	const cwd = await mkdtemp(join(tmpdir(), "omx-native-hook-3481-"));
	const installRoot = await mkdtemp(
		join(tmpdir(), "omx-native-hook-3481-install-"),
	);
	const stateDir = join(cwd, ".omx", "state");
	const sessionId = "sess-3481-conductor";
	const leaderThreadId = "thread-3481-conductor-leader";
	const cliPath = realpathSync(resolve(process.cwd(), "dist", "cli", "omx.js"));
	const absoluteOmx = join(installRoot, "bin", "omx");
	await mkdir(dirname(absoluteOmx), { recursive: true });
	await symlink(cliPath, absoluteOmx);
	await mkdir(join(stateDir, "sessions", sessionId), { recursive: true });
	await writeLeaderSessionFixture(stateDir, sessionId, leaderThreadId, cwd);
	await writeActiveUltragoalConductorState(stateDir, sessionId, "executing");
	const previousEnv = new Map<string, string | undefined>();
	for (const name of [
		"OMX_ROOT",
		"OMX_STATE_ROOT",
		"OMX_TEAM_STATE_ROOT",
		"OMX_SESSION_ID",
		"GJC_SESSION_ID",
		"PATH",
	]) {
		previousEnv.set(name, process.env[name]);
	}
	try {
		process.env.OMX_ROOT = cwd;
		delete process.env.OMX_STATE_ROOT;
		delete process.env.OMX_TEAM_STATE_ROOT;
		delete process.env.OMX_SESSION_ID;
		delete process.env.GJC_SESSION_ID;
		process.env.PATH = `${dirname(process.execPath)}:/usr/bin:/bin`;
		return await run({ cwd, stateDir, sessionId, leaderThreadId, absoluteOmx });
	} finally {
		for (const [name, value] of previousEnv) {
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		}
		await rm(cwd, { recursive: true, force: true });
		await rm(installRoot, { recursive: true, force: true });
	}
}

function leaderBashPayload(
	fixture: ConductorFixture,
	command: string,
): Record<string, unknown> {
	return {
		hook_event_name: "PreToolUse",
		cwd: fixture.cwd,
		session_id: fixture.sessionId,
		thread_id: fixture.leaderThreadId,
		agent_id: fixture.leaderThreadId,
		tool_name: "Bash",
		tool_input: { command },
	};
}

describe("issue-3481: Main-root Conductor deadlock contract repair", () => {
	afterEach(() => {
		// No ambient session/root state may leak across cases.
		for (const name of [
			"OMX_ROOT",
			"OMX_STATE_ROOT",
			"OMX_TEAM_STATE_ROOT",
			"OMX_SESSION_ID",
			"GJC_SESSION_ID",
		]) {
			delete process.env[name];
		}
	});

	it("keeps direct Main-root product/source writes denied while Conductor is active", async () => {
		await withConductorFixture(async (fixture) => {
			for (const [tool_name, tool_input] of [
				["Edit", { file_path: "src/runtime.ts" }],
				["Write", { file_path: "src/runtime.ts", content: "export {};\n" }],
			] as const) {
				const result = await dispatchCodexNativeHook(
					{
						hook_event_name: "PreToolUse",
						cwd: fixture.cwd,
						session_id: fixture.sessionId,
						thread_id: fixture.leaderThreadId,
						agent_id: fixture.leaderThreadId,
						tool_name,
						tool_input,
					},
					{ cwd: fixture.cwd },
				);
				assert.equal(result.outputJson?.decision, "block", tool_name);
				assert.match(
					String(result.outputJson?.reason ?? ""),
					/Main-root Conductor mode is active \(ultragoal phase: executing\)/,
				);
			}

			const bash = await dispatchCodexNativeHook(
				leaderBashPayload(
					fixture,
					"cat <<'EOF' > src/runtime.ts\nimplementation\nEOF",
				),
				{ cwd: fixture.cwd },
			);
			assert.equal(bash.outputJson?.decision, "block");
			assert.match(
				String(bash.outputJson?.reason ?? ""),
				/Main-root Conductor mode is active/,
			);
		});
	});

	it("accepts typed native delegation spawn with an installed agent_type on a positively-supported surface", async () => {
		await withConductorFixture(async (fixture) => {
			for (const tool_name of [
				"collaboration.spawn_agent",
				"multi_agent_v1.spawn_agent",
				"spawn_agent",
				"task",
			]) {
				const result = await dispatchCodexNativeHook(
					{
						hook_event_name: "PreToolUse",
						cwd: fixture.cwd,
						session_id: fixture.sessionId,
						thread_id: fixture.leaderThreadId,
						agent_id: fixture.leaderThreadId,
						omx_runtime_capabilities: {
							native_subagents: true,
							multi_agent_v1: true,
							role_routing: true,
						},
						tool_name,
						tool_input: {
							agent_type: "executor",
							prompt: "implement the approved plan",
						},
					},
					{ cwd: fixture.cwd },
				);
				assert.equal(result.outputJson, null, tool_name);
			}
		});
	});

	it("denies native spawns with a capability-based diagnostic when the surface is not positively supported", async () => {
		await withConductorFixture(async (fixture) => {
			const result = await dispatchCodexNativeHook(
				{
					hook_event_name: "PreToolUse",
					cwd: fixture.cwd,
					session_id: fixture.sessionId,
					thread_id: fixture.leaderThreadId,
					agent_id: fixture.leaderThreadId,
					tool_name: "collaboration.spawn_agent",
					tool_input: {
						agent_type: "executor",
						prompt: "implement the approved plan",
					},
				},
				{ cwd: fixture.cwd },
			);
			assert.equal(result.outputJson?.decision, "block");
			const reason = String(result.outputJson?.reason ?? "");
			assert.match(reason, /documented host-authenticated Main-root authority/);
			assert.match(reason, /detected native subagent capability: unknown/);
			assert.doesNotMatch(reason, /0\.145\.0|Codex 0\.[0-9]+/);
		});
	});

	it("still denies uninstalled agent_type roles on native spawn even on a supported surface", async () => {
		await withConductorFixture(async (fixture) => {
			const result = await dispatchCodexNativeHook(
				{
					hook_event_name: "PreToolUse",
					cwd: fixture.cwd,
					session_id: fixture.sessionId,
					thread_id: fixture.leaderThreadId,
					agent_id: fixture.leaderThreadId,
					omx_runtime_capabilities: {
						native_subagents: true,
						multi_agent_v1: true,
						role_routing: true,
					},
					tool_name: "collaboration.spawn_agent",
					tool_input: {
						agent_type: "not-an-installed-role",
						prompt: "implement",
					},
				},
				{ cwd: fixture.cwd },
			);
			assert.equal(result.outputJson?.decision, "block");
			assert.match(
				String(result.outputJson?.reason ?? ""),
				/unknown or not installed/,
			);
		});
	});

	it("accepts the static omx team launch lane as the authorized implementation path", async () => {
		await withConductorFixture(async (fixture) => {
			for (const command of [
				`${fixture.absoluteOmx} team 1:executor "implement the approved plan"`,
				`${fixture.absoluteOmx} team "fix the parser and add tests"`,
				`${fixture.absoluteOmx} team 3:executor "split docs and code tasks"`,
			]) {
				const result = await dispatchCodexNativeHook(
					leaderBashPayload(fixture, command),
					{ cwd: fixture.cwd },
				);
				assert.equal(result.outputJson, null, command);
			}

			// Documented worker-CLI prefix env is benign launch configuration.
			const previousWorkerCli = process.env.OMX_TEAM_WORKER_CLI;
			process.env.OMX_TEAM_WORKER_CLI = "claude";
			try {
				const prefixed = await dispatchCodexNativeHook(
					leaderBashPayload(
						fixture,
						`${fixture.absoluteOmx} team 2:executor "update docs and report"`,
					),
					{ cwd: fixture.cwd },
				);
				assert.equal(prefixed.outputJson, null);
			} finally {
				if (previousWorkerCli === undefined)
					delete process.env.OMX_TEAM_WORKER_CLI;
				else process.env.OMX_TEAM_WORKER_CLI = previousWorkerCli;
			}

			const gjcPath = join(dirname(fixture.absoluteOmx), "gjc");
			await symlink(fixture.absoluteOmx, gjcPath);
			const gjc = await dispatchCodexNativeHook(
				leaderBashPayload(
					fixture,
					`${gjcPath} team 1:executor "implement via gjc alias"`,
				),
				{ cwd: fixture.cwd },
			);
			assert.equal(gjc.outputJson, null);
		});
	});

	it("keeps dynamic, nested, and lookalike team launches denied under Conductor", async () => {
		await withConductorFixture(async (fixture) => {
			const lookalikeOmx = join(fixture.cwd, "lookalike-omx");
			await writeFile(lookalikeOmx, "#!/bin/sh\necho pwned\n", { mode: 0o755 });
			await chmod(lookalikeOmx, 0o755);
			for (const command of [
				`${fixture.absoluteOmx} team 1:executor "$TASK"`,
				`bash -c '${fixture.absoluteOmx} team 1:executor "$TASK"'`,
				`printf ready && ${fixture.absoluteOmx} team 1:executor "implement"`,
				`${lookalikeOmx} team 1:executor "implement"`,
				`${fixture.absoluteOmx} team`,
				`${fixture.absoluteOmx} team 1:executor "implement" > metadata.json`,
			]) {
				const result = await dispatchCodexNativeHook(
					leaderBashPayload(fixture, command),
					{ cwd: fixture.cwd },
				);
				assert.equal(result.outputJson?.decision, "block", command);
				assert.match(
					String(result.outputJson?.reason ?? ""),
					/Main-root Conductor mode is active/,
					command,
				);
			}
		});
	});

	it("recognizes representative read-only diagnostics under Conductor", async () => {
		await withConductorFixture(async (fixture) => {
			for (const command of [
				`${fixture.absoluteOmx} doctor`,
				`${fixture.absoluteOmx} state list-active --json`,
			]) {
				const result = await dispatchCodexNativeHook(
					leaderBashPayload(fixture, command),
					{ cwd: fixture.cwd },
				);
				assert.equal(result.outputJson, null, command);
			}

			const lookalikeOmx = join(fixture.cwd, "lookalike-omx");
			await writeFile(lookalikeOmx, "#!/bin/sh\necho pwned\n", { mode: 0o755 });
			await chmod(lookalikeOmx, 0o755);
			for (const command of [
				`${fixture.absoluteOmx} doctor --force`,
				`${lookalikeOmx} doctor`,
				`${fixture.absoluteOmx} state list-active --json --unknown`,
			]) {
				const result = await dispatchCodexNativeHook(
					leaderBashPayload(fixture, command),
					{ cwd: fixture.cwd },
				);
				assert.equal(result.outputJson?.decision, "block", command);
			}
		});
	});

	it("allows the documented session-bound omx state write only when inherited binding is canonical", async () => {
		await withConductorFixture(async (fixture) => {
			const minimalPayload = JSON.stringify({
				mode: "ultragoal",
				active: true,
				current_phase: "executing",
			});
			const previousSessionId = process.env.OMX_SESSION_ID;

			// Inherited OMX_SESSION_ID uniquely bound to the authoritative session:
			// the documented minimal `omx state write --input '{"mode":...}' --json`
			// recovery/checkpoint form is a bounded orchestration mutation.
			process.env.OMX_SESSION_ID = fixture.sessionId;
			try {
				const allowed = await dispatchCodexNativeHook(
					leaderBashPayload(
						fixture,
						`${fixture.absoluteOmx} state write --input '${minimalPayload}' --json`,
					),
					{ cwd: fixture.cwd },
				);
				assert.equal(allowed.outputJson, null);
			} finally {
				if (previousSessionId === undefined) delete process.env.OMX_SESSION_ID;
				else process.env.OMX_SESSION_ID = previousSessionId;
			}

			// Without any session binding the write stays denied.
			const unbound = await dispatchCodexNativeHook(
				leaderBashPayload(
					fixture,
					`${fixture.absoluteOmx} state write --input '${minimalPayload}' --json`,
				),
				{ cwd: fixture.cwd },
			);
			assert.equal(unbound.outputJson?.decision, "block");

			// A foreign prefix assignment cannot borrow the inherited binding.
			const foreign = await dispatchCodexNativeHook(
				leaderBashPayload(
					fixture,
					`OMX_SESSION_ID=foreign ${fixture.absoluteOmx} state write --input '${minimalPayload}' --json`,
				),
				{ cwd: fixture.cwd },
			);
			assert.equal(foreign.outputJson?.decision, "block");

			// Guard-breaking payloads stay denied even with a canonical inherited binding.
			process.env.OMX_SESSION_ID = fixture.sessionId;
			try {
				for (const breakingPayload of [
					JSON.stringify({
						mode: "ultragoal",
						active: false,
						current_phase: "complete",
					}),
					JSON.stringify({
						mode: "team",
						active: true,
						current_phase: "active",
					}),
					JSON.stringify({
						mode: "ultragoal",
						active: true,
						current_phase: "complete",
					}),
				]) {
					const breaking = await dispatchCodexNativeHook(
						leaderBashPayload(
							fixture,
							`${fixture.absoluteOmx} state write --input '${breakingPayload}' --json`,
						),
						{ cwd: fixture.cwd },
					);
					assert.equal(breaking.outputJson?.decision, "block", breakingPayload);
				}
			} finally {
				if (previousSessionId === undefined) delete process.env.OMX_SESSION_ID;
				else process.env.OMX_SESSION_ID = previousSessionId;
			}
		});
	});
});
