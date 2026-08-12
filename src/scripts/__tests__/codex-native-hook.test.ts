import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import {
	chmod,
	appendFile,
	mkdir,
	mkdtemp,
	readFile,
	readdir,
	rm,
	symlink,
	utimes,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, it } from "node:test";
import { buildManagedCodexHooksConfig } from "../../config/codex-hooks.js";
import { DOCUMENT_REFRESH_EXEMPTION_PREFIX } from "../../document-refresh/enforcer.js";
import {
	initTeamState,
  readTeamConfig,
	readTeamLeaderAttention,
	readTeamPhase,
  saveTeamConfig,
	writeTeamLeaderAttention,
  writeWorkerIdentity,
} from "../../team/state.js";
import { registerTeamNotice } from "../../team/notice-ledger.js";
import {
	dispatchCodexNativeHook,
	isSloppyFallbackTranscriptStartUsable,
  readUnambiguousSessionStartNativeId,
  resolvePersistedReopenRootContext,
	isCodexNativeHookMainModule,
	looksLikeGoalCompletionPrompt,
	mapCodexHookEventToOmxEvent,
	resolveSessionOwnerPidFromAncestry,
} from "../codex-native-hook.js";
import {
	closeLaunchSessionBindingOnce,
	establishLaunchSessionBinding,
	finalizeBoundOnce,
	updateDetachedSessionMetadata,
	writeSessionStart,
} from "../../hooks/session.js";
import { neutralizeOwnedRoutingRalplan } from '../../ralplan/documented-leader-preflight.js';
import { resetTriageConfigCache } from "../../hooks/triage-config.js";
import { executeStateOperation } from "../../state/operations.js";
import { HUD_TMUX_HEIGHT_LINES } from "../../hud/constants.js";
import { OMX_TMUX_HUD_OWNER_ENV } from "../../hud/reconcile.js";
import { OMX_TMUX_HUD_LEADER_PANE_ENV } from "../../hud/tmux.js";
import { readAllState } from "../../hud/state.js";
import { renderHud } from "../../hud/render.js";
import {
	getLegacyWikiDir,
	serializePage,
	writePage,
} from "../../wiki/storage.js";
import { WIKI_SCHEMA_VERSION } from "../../wiki/types.js";
import {
	createUltragoalPlan,
	readUltragoalPlan,
} from "../../ultragoal/artifacts.js";
import { getBaseStateDir } from "../../state/paths.js";
import { maybeNudgeLeaderForAllowedWorkerStop } from "../notify-hook/team-worker-stop.js";
import { MAX_NATIVE_STDIN_JSON_BYTES } from "../hook-payload-guard.js";


const ARGUMENT_PRODUCING_RUNTIME_DENIAL_COMMANDS = [
  ["node-xargs-wrapper-read", `printf x | xargs node -e "require('fs').readFileSync('src/victim.ts','utf8')"`],
] as const;
const WGET_REVIEW_MUTATION_COMMANDS = [
  ["wget-file-sink-without-hard-cap", "wget --no-config --no-hsts -O .omx/state/inbox/stream https://example.test/file"],
  ["curl-file-sink-with-timeout-but-no-hard-cap", "curl -q --max-time 1 -o .omx/state/inbox/stream https://example.test/file"],
] as const;
const NATIVE_CHILD_MIXED_REFERENCE_STATE_WRITE = [
  "native-child-mixed-reference-state-write",
  `chmod --reference=.omx/state/session.json .omx/state/reference-copy; omx state write --input '{"mode":"ultragoal"}' --json`,
] as const;
const NATIVE_CHILD_REFERENCE_UNKNOWN_COMMAND = [
  "native-child-reference-plus-unknown-command",
  "chmod --reference=.omx/state/session.json .omx/state/reference-copy; unknown-mutation-transport",
] as const;
const NATIVE_CHILD_RSYNC_AUTHORITY_TARGET = [
  "native-child-rsync-authority-target",
  "rsync .omx/state/conductor-ledger.json .omx/state/session.json",
] as const;
const WGET_READ_ONLY_CONTROL_COMMANDS = [
  ["wget-spider-no-body", "wget --no-config --no-hsts --spider https://example.test/file"],
  ["wget-stdout-output-document", "wget --no-config --no-hsts -O - https://example.test/file"],
] as const;
const WGET_MAIN_METADATA_MUTATION_COMMANDS = [
  ["hardlink-metadata-source-control", "ln .omx/state/conductor-ledger.json .omx/handoffs/run-1/ledger-link"],
  ["bounded-truncate-metadata-control", "truncate --size=16777216 .omx/state/inbox/truncate"],
] as const;
const WGET_INHERITED_POSIX_COMMANDS = [
  ["wget-inherited-posix-option-ordering", "wget -O src/posix-inherited-wget-owned.ts https://example.test/file -O -"],
] as const;
function nativeHookScriptPath(): string {
	return join(process.cwd(), "dist", "scripts", "codex-native-hook.js");
}

function parseSingleJsonStdout(stdout: string): Record<string, unknown> {
	const trimmed = stdout.trim();
	assert.notEqual(trimmed, "");
	assert.equal(trimmed.split("\n").length, 1);
	return JSON.parse(trimmed) as Record<string, unknown>;
}

function runNativeHookCli(
	payload: Record<string, unknown> | string,
	options: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
): string {
	return execFileSync(process.execPath, [nativeHookScriptPath()], {
		cwd: options.cwd ?? process.cwd(),
		input: typeof payload === "string" ? payload : JSON.stringify(payload),
		encoding: "utf-8",
		stdio: ["pipe", "pipe", "pipe"],
		env: options.env ?? process.env,
	});
}

function runNativeHookCliResult(
	payload: Record<string, unknown> | string,
	options: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
) {
	return spawnSync(process.execPath, [nativeHookScriptPath()], {
		cwd: options.cwd ?? process.cwd(),
		input: typeof payload === "string" ? payload : JSON.stringify(payload),
		encoding: "utf-8",
		stdio: ["pipe", "pipe", "pipe"],
		env: options.env ?? process.env,
	});
}

const OVERSIZED_STDIN_SYSTEM_MESSAGE = "OMX native hook rejected oversized stdin JSON before parsing; maxBytes=1048576.";

function buildExactByteHookPayload(eventName: "PreToolUse" | "PostToolUse", byteLength: number): string {
	const base = JSON.stringify({
		hook_event_name: eventName,
		session_id: `native-${eventName.toLowerCase()}-😀é`,
		padding: "",
	});
	const paddingBytes = byteLength - Buffer.byteLength(base, "utf8");
	assert.ok(paddingBytes >= 0);
	const payload = JSON.stringify({
		hook_event_name: eventName,
		session_id: `native-${eventName.toLowerCase()}-😀é`,
		padding: "x".repeat(paddingBytes),
	});
	assert.equal(Buffer.byteLength(payload, "utf8"), byteLength);
	assert.notEqual(payload.length, Buffer.byteLength(payload, "utf8"));
	return payload;
}
async function writeJson(path: string, value: unknown): Promise<void> {
	await mkdir(dirname(path), { recursive: true }).catch(() => {});
	await writeFile(path, JSON.stringify(value, null, 2));
}

function readLinuxStartTicks(pid: number): number | null {
	try {
		const stat = readFileSync(`/proc/${pid}/stat`, "utf-8");
		const commandEnd = stat.lastIndexOf(")");
		if (commandEnd === -1) return null;
		const fields = stat.slice(commandEnd + 1).trim().split(/\s+/);
		if (fields.length <= 19) return null;
		const startTicks = Number(fields[19]);
		return Number.isInteger(startTicks) && startTicks >= 0 ? startTicks : null;
	} catch {
		return null;
	}
}

function readLinuxCmdline(pid: number): string | null {
	try {
		const text = readFileSync(`/proc/${pid}/cmdline`, "utf-8").replace(/\0+/g, " ").trim();
		return text.length > 0 ? text : null;
	} catch {
		return null;
	}
}

const AMBIENT_UNSAFE_NODE_RUNTIME_ENV_NAMES = [
	"NODE_OPTIONS",
	"OPENSSL_CONF",
	"NODE_V8_COVERAGE",
	"NODE_COMPILE_CACHE",
	"NODE_REDIRECT_WARNINGS",
	"NODE_REPORT_DIRECTORY",
	"NODE_REPORT_FILENAME",
] as const;

async function withCleanAmbientNodeRuntimeEnvironment<T>(run: () => Promise<T>): Promise<T> {
	const previousRuntimeEnv = Object.fromEntries(
		AMBIENT_UNSAFE_NODE_RUNTIME_ENV_NAMES.map((name) => [name, process.env[name]]),
	);
	for (const name of AMBIENT_UNSAFE_NODE_RUNTIME_ENV_NAMES) delete process.env[name];
	try {
		return await run();
	} finally {
		for (const name of AMBIENT_UNSAFE_NODE_RUNTIME_ENV_NAMES) {
			if (previousRuntimeEnv[name] === undefined) delete process.env[name];
			else process.env[name] = previousRuntimeEnv[name];
		}
	}
}

async function writeCanonicalLeaderFixture(
	stateDir: string,
	sessionId: string,
	leaderThreadId: string,
	cwd: string,
): Promise<void> {
	await writeJson(join(stateDir, "session.json"), {
		session_id: sessionId,
		leader_thread_id: leaderThreadId,
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

async function withTrustedWorkspaceOmxCli<T>(
  cwd: string,
  action: (omxCommand: string, trustedPath: string) => Promise<T>,
  commandForm: "assignment" | "env" = "assignment",
): Promise<T> {
  const cliPath = realpathSync(resolve(process.cwd(), "dist", "cli", "omx.js"));
  const binDir = join(cwd, "node_modules", ".bin");
  const shimPath = join(binDir, "omx");
  await mkdir(binDir, { recursive: true });
  await rm(shimPath, { force: true });
  await symlink(cliPath, shimPath);
  const path = `${binDir}:${dirname(process.execPath)}:/usr/bin:/bin`;
  return await action(commandForm === "env" ? `env PATH="${path}" omx` : `PATH="${path}" omx`, path);
}

async function writeNativeMappedSessionState(
	cwd: string,
	stateDir: string,
	sessionId: string,
	nativeSessionId: string,
  leaderThreadId?: string,
): Promise<void> {
	await mkdir(join(stateDir, "sessions", sessionId), { recursive: true });
	await writeJson(join(stateDir, "session.json"), {
		session_id: sessionId,
		native_session_id: nativeSessionId,
		cwd,
	});
  if (leaderThreadId) {
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
}

async function writeLiveNativeMappedSessionState(
	cwd: string,
	stateDir: string,
	sessionId: string,
	nativeSessionId: string,
  leaderThreadId?: string,
): Promise<void> {
	await mkdir(join(stateDir, "sessions", sessionId), { recursive: true });
	const liveState = await writeSessionStart(cwd, sessionId, {
		nativeSessionId,
	});
	const liveStatePath = join(cwd, ".omx", "state", "session.json");
	const targetStatePath = join(stateDir, "session.json");
	if (liveStatePath !== targetStatePath) {
		await writeFile(targetStatePath, JSON.stringify(liveState, null, 2));
	}
  if (leaderThreadId) {
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
}

async function writeLiveNativeSessionOwnerSidecar(
	cwd: string,
	stateDir: string,
	sessionId: string,
): Promise<void> {
	const selected = JSON.parse(
		await readFile(join(stateDir, "session.json"), "utf-8"),
	) as Record<string, unknown>;
	await writeJson(
		join(stateDir, "sessions", sessionId, "session-owner.json"),
		{
			...selected,
			session_id: sessionId,
			native_session_id: sessionId,
			started_at: new Date().toISOString(),
			cwd,
		},
	);
}

async function withIndependentNativeSession(
	suffix: string,
	run: (fixture: {
		cwd: string;
		stateDir: string;
		sessionId: string;
		pointerBefore: string;
	}) => Promise<void>,
): Promise<void> {
	const cwd = await mkdtemp(join(tmpdir(), `omx-native-hook-sidecar-${suffix}-`));
	try {
		const stateDir = join(cwd, ".omx", "state");
		const selectedSessionId = `native-selected-${suffix}`;
		const sessionId = `native-independent-${suffix}`;
		await writeSessionStart(cwd, selectedSessionId, {
			nativeSessionId: selectedSessionId,
			pid: process.pid,
		});
		await writeLiveNativeSessionOwnerSidecar(cwd, stateDir, sessionId);
		await run({
			cwd,
			stateDir,
			sessionId,
			pointerBefore: await readFile(join(stateDir, "session.json"), "utf-8"),
		});
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
}

async function writeSessionSkillActiveState(
	stateDir: string,
	sessionId: string,
	skill: string,
	phase: string,
): Promise<void> {
	await writeJson(
		join(stateDir, "sessions", sessionId, "skill-active-state.json"),
		{
			active: true,
			skill,
			phase,
			session_id: sessionId,
			active_skills: [{ skill, phase, active: true, session_id: sessionId }],
		},
	);
}


async function writeIssue3239ActiveAutopilotDeepInterviewState(
	cwd: string,
	sessionId: string,
	threadId: string,
): Promise<void> {
	const stateDir = join(cwd, ".omx", "state");
	const sessionDir = join(stateDir, "sessions", sessionId);
	await mkdir(sessionDir, { recursive: true });
	await writeJson(join(stateDir, "session.json"), {
		session_id: sessionId,
		leader_thread_id: threadId,
		cwd,
	});
	await writeJson(join(stateDir, "subagent-tracking.json"), {
		schemaVersion: 1,
		sessions: {
			[sessionId]: {
				session_id: sessionId,
				leader_thread_id: threadId,
				threads: {
					[threadId]: { thread_id: threadId, kind: "leader" },
				},
			},
		},
	});
	await writeJson(join(sessionDir, "skill-active-state.json"), {
		version: 1,
		active: true,
		skill: "autopilot",
		phase: "deep-interview",
		session_id: sessionId,
		thread_id: threadId,
		active_skills: [
			{ skill: "autopilot", phase: "deep-interview", active: true, session_id: sessionId, thread_id: threadId },
		],
	});
	await writeJson(join(sessionDir, "autopilot-state.json"), {
		active: true,
		mode: "autopilot",
		current_phase: "deep-interview",
		session_id: sessionId,
		thread_id: threadId,
		workingDirectory: cwd,
		deep_interview_gate: { status: "required" },
	});
	await writeJson(join(sessionDir, "deep-interview-state.json"), {
		active: true,
		mode: "deep-interview",
		current_phase: "intent-first",
		session_id: sessionId,
		thread_id: threadId,
		workingDirectory: cwd,
	});
}

async function setTeamPaneIds(
	cwd: string,
	teamName: string,
	paneIds: { leaderPaneId: string; workerPaneIds: Record<string, string> },
): Promise<void> {
	for (const fileName of ["config.json", "manifest.v2.json"]) {
		const filePath = join(cwd, ".omx", "state", "team", teamName, fileName);
		const parsed = JSON.parse(await readFile(filePath, "utf-8")) as {
			leader_pane_id?: string | null;
			workers?: Array<{ name?: string; pane_id?: string | null }>;
		};
		parsed.leader_pane_id = paneIds.leaderPaneId;
		parsed.workers = (parsed.workers ?? []).map((worker) => ({
			...worker,
			pane_id: worker.name
				? (paneIds.workerPaneIds[worker.name] ?? worker.pane_id ?? null)
				: (worker.pane_id ?? null),
		}));
		await writeJson(filePath, parsed);
	}
}

async function configureAuthoritativeTeamWorker(
  cwd: string,
  teamName: string,
  workerPaneId = "%10",
): Promise<void> {
  const stateRoot = join(cwd, ".omx", "state");
  await initTeamState(teamName, "session pointer ownership regression", "executor", 1, cwd, undefined, {
    OMX_SESSION_ID: "leader-session",
  });
  await setTeamPaneIds(cwd, teamName, {
    leaderPaneId: "%42",
    workerPaneIds: { "worker-1": workerPaneId },
  });
  for (const fileName of ["config.json", "manifest.v2.json"]) {
    const filePath = join(stateRoot, "team", teamName, fileName);
    const state = JSON.parse(await readFile(filePath, "utf-8")) as {
      team_state_root?: string;
      leader_cwd?: string;
      workers?: Array<Record<string, unknown>>;
    };
    state.team_state_root = stateRoot;
    state.leader_cwd = cwd;
    state.workers = (state.workers ?? []).map((worker) => ({
      ...worker,
      working_dir: cwd,
      worktree_path: cwd,
      team_state_root: stateRoot,
    }));
    await writeJson(filePath, state);
  }
  await writeJson(join(stateRoot, "team", teamName, "workers", "worker-1", "identity.json"), {
    name: "worker-1",
    index: 1,
    role: "executor",
    pane_id: workerPaneId,
    working_dir: cwd,
    worktree_path: cwd,
    team_state_root: stateRoot,
  });
  process.env.TMUX = "1";
  process.env.TMUX_PANE = workerPaneId;
  process.env.OMX_TEAM_INTERNAL_WORKER = `${teamName}/worker-1`;
  process.env.OMX_TEAM_WORKER = `${teamName}/worker-1`;
  process.env.OMX_TEAM_STATE_ROOT = stateRoot;
  process.env.OMX_TEAM_LEADER_CWD = cwd;
  process.env.OMX_SESSION_ID = "leader-session";
}

async function withIsolatedHome<T>(
	prefix: string,
	run: (homeDir: string) => Promise<T>,
): Promise<T> {
	const homeDir = await mkdtemp(
		join(tmpdir(), `omx-native-hook-home-${prefix}-`),
	);
	const previousHome = process.env.HOME;
	try {
		process.env.HOME = homeDir;
		return await run(homeDir);
	} finally {
		if (typeof previousHome === "string") process.env.HOME = previousHome;
		else delete process.env.HOME;
		await rm(homeDir, { recursive: true, force: true });
	}
}

async function withLoreGuardConfig<T>(
	value: string,
	prefix: string,
	run: (cwd: string) => Promise<T>,
): Promise<T> {
	const cwd = await mkdtemp(
		join(tmpdir(), `omx-native-hook-pretool-git-commit-lore-${prefix}-`),
	);
	const codexHome = await mkdtemp(
		join(tmpdir(), `omx-native-hook-codex-home-lore-${prefix}-`),
	);
	const defaultHome = await mkdtemp(
		join(tmpdir(), `omx-native-hook-home-lore-${prefix}-`),
	);
	const originalGuard = process.env.OMX_LORE_COMMIT_GUARD;
	const originalCodexHome = process.env.CODEX_HOME;
	const originalHome = process.env.HOME;
	try {
		delete process.env.OMX_LORE_COMMIT_GUARD;
		process.env.CODEX_HOME = codexHome;
		process.env.HOME = defaultHome;
		await writeFile(
			join(codexHome, "config.toml"),
			`[shell_environment_policy.set]\nOMX_LORE_COMMIT_GUARD = "${value}"\n`,
			"utf-8",
		);
		return await run(cwd);
	} finally {
		if (originalGuard === undefined) delete process.env.OMX_LORE_COMMIT_GUARD;
		else process.env.OMX_LORE_COMMIT_GUARD = originalGuard;
		if (originalCodexHome === undefined) delete process.env.CODEX_HOME;
		else process.env.CODEX_HOME = originalCodexHome;
		if (originalHome === undefined) delete process.env.HOME;
		else process.env.HOME = originalHome;
		await rm(cwd, { recursive: true, force: true });
		await rm(codexHome, { recursive: true, force: true });
		await rm(defaultHome, { recursive: true, force: true });
	}
}

function buildWorkerStopFakeTmux(
	tmuxLogPath: string,
	options: {
		failSend?: boolean;
		busyLeader?: boolean;
		captureText?: string;
		currentCommand?: string;
		sendDelayMs?: number;
		removePathOnSend?: string;
		removePathOnCapture?: string;
	} = {},
): string {
	const rawCaptureText =
		options.captureText ??
		(options.busyLeader ? "• Working… (esc to interrupt)" : "› ready");
	const captureText = `'${rawCaptureText.replace(/'/g, "'\"'\"'")}'`;
	const currentCommand = `'${(options.currentCommand ?? "codex").replace(/'/g, "'\"'\"'")}'`;
	const sendDelaySeconds = Math.max(0, options.sendDelayMs ?? 0) / 1000;
	const removePathOnSend = options.removePathOnSend
		? `'${options.removePathOnSend.replace(/'/g, "'\"'\"'")}'`
		: "";
	const removePathOnCapture = options.removePathOnCapture
		? `'${options.removePathOnCapture.replace(/'/g, "'\"'\"'")}'`
		: "";
	return `#!/usr/bin/env bash
set -eu
echo "$@" >> "${tmuxLogPath}"
cmd="$1"
shift || true
if [[ "$cmd" == "show-option" && "\${@: -1}" == "@omx_team_pane_owner_id" ]]; then
  printf '%s\n' 'team:test'
  exit 0
fi
if [[ "$cmd" == "display-message" ]]; then
  fmt=""
  while [[ "$#" -gt 0 ]]; do
    case "$1" in
      -p) ;;
      -t) shift ;;
      *) fmt="$1" ;;
    esac
    shift || true
  done
  case "$fmt" in
    "#{pane_in_mode}") echo "0" ;;
    "#{pane_id}") echo "%42" ;;
    "#{pane_current_path}") pwd ;;
    "#{pane_start_command}") echo "codex" ;;
    "#{pane_current_command}") printf '%s\\n' ${currentCommand} ;;
    "#S") echo "omx-team-worker-stop" ;;
    *) ;;
  esac
  exit 0
fi
if [[ "$cmd" == "list-panes" ]]; then
  printf '%%10\t0\t12310\n%%11\t0\t12311\n%%42\t0\t12345\n'
  exit 0
fi
if [[ "$cmd" == "capture-pane" ]]; then
  ${removePathOnCapture ? `rm -rf ${removePathOnCapture}` : ""}
  printf '%s\\n' ${captureText}
  exit 0
fi
if [[ "$cmd" == "set-buffer" ]]; then
  printf '%s' "\${@: -1}" > "${tmuxLogPath}.buffer"
  exit 0
fi
if [[ "$cmd" == "show-buffer" ]]; then
  if [[ -f "${tmuxLogPath}.buffer" ]]; then cat "${tmuxLogPath}.buffer"; fi
  exit 0
fi
if [[ "$cmd" == "paste-buffer" ]]; then
  target=""
  while [[ "$#" -gt 0 ]]; do
    case "$1" in
      -t) target="$2"; shift 2 ;;
      *) shift ;;
    esac
  done
  if [[ -f "${tmuxLogPath}.buffer" ]]; then
    echo "send-keys -t \${target} -l $(cat "${tmuxLogPath}.buffer")" >> "${tmuxLogPath}"
  fi
  exit 0
fi
if [[ "$cmd" == "delete-buffer" ]]; then
  rm -f "${tmuxLogPath}.buffer"
  exit 0
fi
if [[ "$cmd" == "send-keys" ]]; then
  ${sendDelaySeconds > 0 ? `sleep ${sendDelaySeconds}` : ""}
  ${removePathOnSend ? `rm -rf ${removePathOnSend}` : ""}
  ${options.failSend ? "exit 1" : "exit 0"}
fi
exit 0
`;
}

function buildSessionOwnerEvidenceTmux(paneInstanceId: string, sessionInstanceId = ""): string {
  return `#!/usr/bin/env bash
set -eu
case "\${1:-}" in
display-message) printf '%s\n' "omx-owner-evidence" ;;
show-option|show-options)
case "\${@: -1}" in
@omx_pane_instance_id) printf '%s\n' "${paneInstanceId}" ;;
@omx_instance_id) printf '%s\n' "${sessionInstanceId}" ;;
esac
;;
esac
`;
}

async function initTempGitRepo(prefix: string): Promise<string> {
	const cwd = await mkdtemp(join(tmpdir(), prefix));
	execFileSync("git", ["init"], { cwd, stdio: "ignore" });
	execFileSync("git", ["config", "user.email", "test@example.com"], {
		cwd,
		stdio: "ignore",
	});
	execFileSync("git", ["config", "user.name", "Test User"], {
		cwd,
		stdio: "ignore",
	});
	return cwd;
}

async function writeActiveAutopilotSession(
	cwd: string,
	sessionId: string,
): Promise<void> {
	await writeJson(join(cwd, ".omx", "state", "session.json"), {
		session_id: sessionId,
	});
	await writeJson(
		join(cwd, ".omx", "state", "sessions", sessionId, "autopilot-state.json"),
		{
			active: true,
			current_phase: "execution",
		},
	);
}

async function writeHookCounterPlugin(cwd: string): Promise<string> {
	const markerPath = join(cwd, ".omx", "stop-hook-counter.json");
	await mkdir(join(cwd, ".omx", "hooks"), { recursive: true });
	await writeFile(
		join(cwd, ".omx", "hooks", "count-stop-hook.mjs"),
		`import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export async function onHookEvent(event) {
  if (event.event !== "stop") return;
  const outPath = join(process.cwd(), ".omx", "stop-hook-counter.json");
  await mkdir(dirname(outPath), { recursive: true });
  let count = 0;
  try {
    count = JSON.parse(await readFile(outPath, "utf-8")).count || 0;
  } catch {}
  await writeFile(outPath, JSON.stringify({ count: count + 1 }, null, 2));
}
`,
		"utf-8",
	);
	return markerPath;
}

async function writeReleaseReadinessLeaderAttention(
	teamName: string,
	sessionId: string,
	cwd: string,
	options: { workRemaining: boolean },
): Promise<void> {
	await writeTeamLeaderAttention(
		teamName,
		{
			team_name: teamName,
			updated_at: "2026-04-12T17:20:00.000Z",
			source: "notify_hook",
			leader_decision_state: "done_waiting_on_leader",
			leader_attention_pending: true,
			leader_attention_reason: "leader_session_stopped",
			attention_reasons: ["leader_session_stopped"],
			leader_stale: true,
			leader_session_active: false,
			leader_session_id: sessionId,
			leader_session_stopped_at: "2026-04-12T17:20:00.000Z",
			unread_leader_message_count: 0,
			work_remaining: options.workRemaining,
			stalled_for_ms: null,
		},
		cwd,
	);
}

async function writeReleaseReadinessStateMarker(
	sessionId: string,
	teamName: string,
	cwd: string,
): Promise<void> {
	await writeJson(
		join(
			cwd,
			".omx",
			"state",
			"sessions",
			sessionId,
			"release-readiness-state.json",
		),
		{
			active: true,
			session_id: sessionId,
			team_name: teamName,
			stable_final_recommendation_emitted: true,
		},
	);
}

const TEAM_STOP_COMMIT_GUIDANCE =
	" If system-generated worker auto-checkpoint commits exist, rewrite them into Lore-format final commits before merge/finalization.";
const DEFAULT_AUTO_NUDGE_RESPONSE =
	"continue with the current task only if it is already authorized";

const TEAM_ENV_KEYS = [
  "OMX_TEAM_WORKER",
  "OMX_TEAM_INTERNAL_WORKER",
  "OMX_TEAM_STATE_ROOT",
  "OMX_TEAM_LEADER_CWD",
  "OMX_TEAM_MODE",
  "OMX_SESSION_ID",
  "OMX_ROOT",
  "OMX_STATE_ROOT",
  "SESSION_ID",
  "OMX_QUESTION_RETURN_PANE",
  "OMX_LEADER_PANE_ID",
  "TMUX",
  "TMUX_PANE",
  "OMX_TMUX_HUD_OWNER",
  "OMX_NATIVE_STOP_NO_PROGRESS_MAX_REPEATS",
  "OMX_NATIVE_STOP_NO_PROGRESS_IDLE_MS",
] as const;

const priorTeamEnv = new Map<
	(typeof TEAM_ENV_KEYS)[number],
	string | undefined
>();

beforeEach(() => {
	priorTeamEnv.clear();
	for (const key of TEAM_ENV_KEYS) {
		priorTeamEnv.set(key, process.env[key]);
		delete process.env[key];
	}
});

afterEach(() => {
	for (const key of TEAM_ENV_KEYS) {
		const value = priorTeamEnv.get(key);
		if (typeof value === "string") process.env[key] = value;
		else delete process.env[key];
	}
	priorTeamEnv.clear();
});

describe("codex native hook config", () => {
	it("builds the expected managed hooks.json shape", () => {
		const config = buildManagedCodexHooksConfig("/tmp/omx");
		assert.deepEqual(Object.keys(config.hooks), [
			"SessionStart",
			"PreToolUse",
			"PostToolUse",
			"UserPromptSubmit",
			"PreCompact",
			"PostCompact",
			"Stop",
		]);

		const sessionStart = config.hooks.SessionStart[0] as {
			matcher?: string;
			hooks?: Array<Record<string, unknown>>;
		};
		assert.equal(sessionStart.matcher, "startup|resume|clear");
		assert.equal(sessionStart.hooks?.[0]?.statusMessage, undefined);

		const preToolUse = config.hooks.PreToolUse[0] as {
			matcher?: string;
			hooks?: Array<Record<string, unknown>>;
		};
		assert.equal(preToolUse.matcher, undefined);
		assert.match(
			String(preToolUse.hooks?.[0]?.command || ""),
			/codex-native-hook\.js"?$/,
		);
		assert.equal(preToolUse.hooks?.[0]?.statusMessage, undefined);

		const postToolUse = config.hooks.PostToolUse[0] as {
			matcher?: string;
			hooks?: Array<Record<string, unknown>>;
		};
		assert.equal(postToolUse.matcher, undefined);
		assert.match(
			String(postToolUse.hooks?.[0]?.command || ""),
			/codex-native-hook\.js"?$/,
		);
		assert.equal(postToolUse.hooks?.[0]?.statusMessage, undefined);

		const userPromptSubmit = config.hooks.UserPromptSubmit[0] as {
			matcher?: string;
			hooks?: Array<Record<string, unknown>>;
		};
		assert.equal(userPromptSubmit.matcher, undefined);
		assert.match(
			String(userPromptSubmit.hooks?.[0]?.command || ""),
			/codex-native-hook\.js"?$/,
		);
		assert.equal(userPromptSubmit.hooks?.[0]?.statusMessage, undefined);

		const stop = config.hooks.Stop[0] as {
			hooks?: Array<Record<string, unknown>>;
		};
		assert.equal(stop.hooks?.[0]?.timeout, 30);

		const postCompact = config.hooks.PostCompact[0] as {
			matcher?: string;
			hooks?: Array<Record<string, unknown>>;
		};
		assert.equal(postCompact.matcher, undefined);
		assert.match(
			String(postCompact.hooks?.[0]?.command || ""),
			/codex-native-hook\.js"?$/,
		);
		assert.doesNotMatch(
			String(postCompact.hooks?.[0]?.command || ""),
			/PostCompact Nudge|additionalContext|printf/,
		);
	});
});

describe("codex native hook dispatch", { concurrency: false }, () => {
	it("treats space-containing argv entry paths as the main module", () => {
		const entryPath = "/tmp/omx native/codex-native-hook.js";

		assert.equal(
			isCodexNativeHookMainModule(pathToFileURL(entryPath).href, entryPath),
			true,
		);
	});

	it("does not treat a different module url as the main module", () => {
		assert.equal(
			isCodexNativeHookMainModule(
				pathToFileURL("/tmp/omx native/other-script.js").href,
				"/tmp/omx native/codex-native-hook.js",
			),
			false,
		);
	});

	it("emits Stop-schema-safe block JSON when unidentifiable malformed stdin has native Stop runtime surface", async () => {
		const cwd = await mkdtemp(
			join(tmpdir(), "omx-native-hook-cli-malformed-stop-surface-"),
		);
		try {
			await mkdir(join(cwd, ".omx"), { recursive: true });
			const result = spawnSync(process.execPath, [nativeHookScriptPath()], {
				cwd,
				input: "{",
				encoding: "utf-8",
				stdio: ["pipe", "pipe", "pipe"],
			});

			assert.equal(result.status, 0, result.stderr || result.stdout);
			assert.equal(result.stderr, "");
			const output = parseSingleJsonStdout(result.stdout) as {
				decision?: string;
				continue?: boolean;
				reason?: string;
				stopReason?: string;
				systemMessage?: string;
				hookSpecificOutput?: unknown;
			};

			assert.equal(output.decision, "block");
			assert.equal(output.continue, undefined);
			assert.equal(
				output.reason,
				"OMX native hook received malformed JSON input. Preserve runtime state, inspect the emitting hook payload yourself, and retry with valid JSON.",
			);
			assert.equal(output.stopReason, "native_hook_stdin_parse_error");
			assert.equal(output.hookSpecificOutput, undefined);
			assert.match(
				String(output.systemMessage ?? ""),
				/stdin JSON parsing failed inside codex-native-hook:/,
			);
		} finally {
			await rm(cwd, { recursive: true, force: true });
		}
	});

	it("preserves non-Stop fail-closed JSON when malformed stdin identifies a non-Stop hook", async () => {
		const cwd = await mkdtemp(
			join(tmpdir(), "omx-native-hook-cli-malformed-nonstop-"),
		);
		try {
			await mkdir(join(cwd, ".omx"), { recursive: true });
			const result = spawnSync(process.execPath, [nativeHookScriptPath()], {
				cwd,
				input: '{hook_event_name:"PreToolUse",',
				encoding: "utf-8",
				stdio: ["pipe", "pipe", "pipe"],
			});

			assert.equal(result.status, 0, result.stderr || result.stdout);
			assert.equal(result.stderr, "");
			const output = parseSingleJsonStdout(result.stdout) as {
				continue?: boolean;
				decision?: string;
				stopReason?: string;
				systemMessage?: string;
				hookSpecificOutput?: unknown;
			};

      const hookSpecificOutput = output.hookSpecificOutput as {
        hookEventName?: string;
        permissionDecision?: string;
        permissionDecisionReason?: string;
      } | undefined;
			assert.equal(output.continue, undefined);
			assert.equal(output.decision, undefined);
			assert.equal(output.stopReason, undefined);
      assert.equal(hookSpecificOutput?.hookEventName, "PreToolUse");
      assert.equal(hookSpecificOutput?.permissionDecision, "deny");
      assert.equal(
        hookSpecificOutput?.permissionDecisionReason,
        "OMX native hook received malformed JSON input. Preserve runtime state, inspect the emitting hook payload yourself, and retry with valid JSON.",
      );
			assert.match(
				String(output.systemMessage ?? ""),
				/stdin JSON parsing failed inside codex-native-hook:/,
			);
		} finally {
			await rm(cwd, { recursive: true, force: true });
		}
	});

	it("redacts unterminated prompt-like malformed stdin fields", async () => {
		const cwd = await mkdtemp(
			join(tmpdir(), "omx-native-hook-cli-malformed-unterminated-"),
		);
		try {
			const privatePrompt = "PRIVATE_UNTERMINATED_PROMPT";
			const malformed = `{hook_event_name:"PostToolUse", prompt:"${privatePrompt}`;
			const result = spawnSync(process.execPath, [nativeHookScriptPath()], {
				cwd,
				input: malformed,
				encoding: "utf-8",
				stdio: ["pipe", "pipe", "pipe"],
			});

			assert.equal(result.status, 0, result.stderr || result.stdout);
			assert.equal(result.stderr, "");
			const output = parseSingleJsonStdout(result.stdout);
			assert.equal(output.stopReason, "native_hook_stdin_parse_error");

			const log = await readFile(
				join(
					cwd,
					".omx",
					"logs",
					`native-hook-${new Date().toISOString().split("T")[0]}.jsonl`,
				),
				"utf-8",
			);
			const entry = JSON.parse(log.trim()) as Record<string, unknown>;
			const prefix = String(entry.raw_input_prefix ?? "");
			assert.doesNotMatch(prefix, new RegExp(privatePrompt));
			assert.match(prefix, /prompt:"\[REDACTED\]"/);
		} finally {
			await rm(cwd, { recursive: true, force: true });
		}
	});

	it("logs a bounded redacted raw stdin prefix when CLI stdin is malformed", async () => {
		const cwd = await mkdtemp(
			join(tmpdir(), "omx-native-hook-cli-malformed-log-prefix-"),
		);
		try {
			const secret = "sk-test-secret123456";
			const promptText = "summarize private launch notes";
			const malformed = `{hook_event_name:"PostToolUse", access_token:"${secret}", prompt:"${promptText}", text:"${promptText}", bad:"${"x".repeat(400)}"}${String.fromCharCode(10, 0, 7)}`;
			const result = spawnSync(process.execPath, [nativeHookScriptPath()], {
				cwd,
				input: malformed,
				encoding: "utf-8",
				stdio: ["pipe", "pipe", "pipe"],
			});

			assert.equal(result.status, 0, result.stderr || result.stdout);
			assert.equal(result.stderr, "");
			const output = parseSingleJsonStdout(result.stdout);
			assert.equal(output.stopReason, "native_hook_stdin_parse_error");

			const log = await readFile(
				join(
					cwd,
					".omx",
					"logs",
					`native-hook-${new Date().toISOString().split("T")[0]}.jsonl`,
				),
				"utf-8",
			);
			const entry = JSON.parse(log.trim()) as Record<string, unknown>;
			const prefix = String(entry.raw_input_prefix ?? "");
			assert.equal(entry.type, "native_hook_stdin_parse_error");
			assert.equal(
				entry.raw_input_length,
				Buffer.byteLength(malformed, "utf-8"),
			);
			assert.ok(
				prefix.length <= 240,
				`prefix should be bounded, got ${prefix.length}`,
			);
			assert.doesNotMatch(prefix, /[\u0000-\u001f\u007f-\u009f]/);
			assert.doesNotMatch(prefix, new RegExp(secret));
			assert.doesNotMatch(prefix, new RegExp(promptText));
			assert.match(prefix, /\[REDACTED\]/);
		} finally {
			await rm(cwd, { recursive: true, force: true });
		}
	});

	it("emits Stop-schema-safe block JSON when malformed stdin still identifies Stop", () => {
		const stdout = runNativeHookCli('{hook_event_name:"Stop",');

		const output = parseSingleJsonStdout(stdout) as {
			decision?: string;
			reason?: string;
			stopReason?: string;
			systemMessage?: string;
			hookSpecificOutput?: unknown;
		};

		assert.equal(output.decision, "block");
		assert.equal(
			output.reason,
			"OMX native hook received malformed JSON input. Preserve runtime state, inspect the emitting hook payload yourself, and retry with valid JSON.",
		);
		assert.equal(output.stopReason, "native_hook_stdin_parse_error");
		assert.equal(output.hookSpecificOutput, undefined);
		assert.match(
			String(output.systemMessage ?? ""),
			/stdin JSON parsing failed inside codex-native-hook:/,
		);
	});

	it("emits no-op JSON stdout for PreToolUse non-Bash tools with null output", async () => {
		const cwd = await mkdtemp(
			join(tmpdir(), "omx-native-hook-cli-pretool-nonbash-noop-"),
		);
		try {
			const result = spawnSync(process.execPath, [nativeHookScriptPath()], {
				cwd,
				input: JSON.stringify({
					hook_event_name: "PreToolUse",
					cwd,
					session_id: "sess-cli-pretool-nonbash-noop",
					thread_id: "thread-cli-pretool-nonbash-noop",
					turn_id: "turn-cli-pretool-nonbash-noop",
					tool_name: "Read",
					tool_input: { file_path: "package.json" },
				}),
				encoding: "utf-8",
				stdio: ["pipe", "pipe", "pipe"],
			});

			assert.equal(result.status, 0, result.stderr || result.stdout);
			assert.equal(result.stderr, "");
			assert.deepEqual(parseSingleJsonStdout(result.stdout), {});
		} finally {
			await rm(cwd, { recursive: true, force: true });
		}
	});

	it("emits PreToolUse CLI advisory JSON with only systemMessage", async () => {
		const cwd = await mkdtemp(
			join(tmpdir(), "omx-native-hook-cli-pretool-schema-safe-"),
		);
		try {
			const output = parseSingleJsonStdout(
				runNativeHookCli(
					{
						hook_event_name: "PreToolUse",
						cwd,
						session_id: "sess-cli-pretool-schema-safe",
						thread_id: "thread-cli-pretool-schema-safe",
						turn_id: "turn-cli-pretool-schema-safe",
						tool_name: "Bash",
						tool_input: { command: "rm -rf dist" },
					},
					{ cwd },
				),
			);

			assert.deepEqual(output, {
				systemMessage:
					"Destructive Bash command detected (`rm -rf dist`). Confirm the target and expected side effects before running it.",
			});
		} finally {
			await rm(cwd, { recursive: true, force: true });
		}
	});

	it("emits PreToolUse CLI block JSON as hook-specific deny with preserved systemMessage guidance", async () => {
		const cwd = await mkdtemp(
			join(tmpdir(), "omx-native-hook-cli-pretool-block-schema-safe-"),
		);
		try {
			const result = runNativeHookCliResult(
				{
					hook_event_name: "PreToolUse",
					cwd,
					session_id: "sess-cli-pretool-block-schema-safe",
					thread_id: "thread-cli-pretool-block-schema-safe",
					turn_id: "turn-cli-pretool-block-schema-safe",
					tool_name: "Bash",
					tool_input: {
						command: 'OMX_LORE_COMMIT_GUARD=1 git commit -m "fix tests"',
					},
				},
				{ cwd },
			);

			assert.equal(result.status, 0, result.stderr || result.stdout);
			const output = parseSingleJsonStdout(result.stdout);
			const hookSpecificOutput = output.hookSpecificOutput as Record<
				string,
				unknown
			>;

			assert.deepEqual(Object.keys(output).sort(), [
				"hookSpecificOutput",
				"systemMessage",
			]);
			assert.match(String(output.systemMessage ?? ""), /Lore protocol/);
			assert.equal(output.decision, undefined);
			assert.equal(output.reason, undefined);
			assert.equal(output.stopReason, undefined);
			assert.equal(hookSpecificOutput.hookEventName, "PreToolUse");
			assert.equal(hookSpecificOutput.permissionDecision, "deny");
			assert.equal(
				hookSpecificOutput.permissionDecisionReason,
				"git commit is blocked until the inline commit message satisfies the Lore format and includes the required OmX co-author trailer.",
			);
		} finally {
			await rm(cwd, { recursive: true, force: true });
		}
	});

	it("preserves ralplan PreToolUse planning guard as hook-specific deny JSON", async () => {
		const cwd = await mkdtemp(
			join(tmpdir(), "omx-native-hook-cli-ralplan-pretool-boundary-"),
		);
		const sessionId = "sess-cli-ralplan-pretool-boundary";
		const stateDir = join(cwd, ".omx", "state");
		try {
			await writeJson(join(stateDir, "session.json"), {
				session_id: sessionId,
			});
			await writeJson(
				join(stateDir, "sessions", sessionId, "skill-active-state.json"),
				{
					active: true,
					skill: "ralplan",
					phase: "planning",
					session_id: sessionId,
					active_skills: [
						{
							skill: "ralplan",
							phase: "planning",
							active: true,
							session_id: sessionId,
						},
					],
				},
			);
			await writeJson(
				join(stateDir, "sessions", sessionId, "ralplan-state.json"),
				{
					active: true,
					mode: "ralplan",
					current_phase: "critic-review",
					session_id: sessionId,
				},
			);
			await writeCanonicalLeaderFixture(
				stateDir,
				sessionId,
				"thread-cli-ralplan-pretool-boundary",
				cwd,
			);


			const result = runNativeHookCliResult(
				{
					hook_event_name: "PreToolUse",
					cwd,
					session_id: sessionId,
					thread_id: "thread-cli-ralplan-pretool-boundary",
					agent_id: "thread-cli-ralplan-pretool-boundary",
					tool_name: "Edit",
					tool_input: {
						file_path: "src/runtime.ts",
						old_string: "a",
						new_string: "b",
					},
				},
				{ cwd },
			);

			assert.equal(result.status, 0, result.stderr || result.stdout);
			const output = parseSingleJsonStdout(result.stdout);
			const hookSpecificOutput = output.hookSpecificOutput as Record<
				string,
				unknown
			>;
			assert.deepEqual(Object.keys(output).sort(), ["hookSpecificOutput"]);
			assert.equal(hookSpecificOutput.hookEventName, "PreToolUse");
			assert.equal(hookSpecificOutput.permissionDecision, "deny");
			assert.match(
				String(hookSpecificOutput.permissionDecisionReason ?? ""),
				/Ralplan is active \(phase: critic-review\)/,
			);
			assert.match(
				String(hookSpecificOutput.permissionDecisionReason ?? ""),
				/implementation\/write tools are blocked/,
			);
			assert.match(
				String(hookSpecificOutput.additionalContext ?? ""),
				/Write only planning artifacts/,
			);
			assert.equal(output.decision, undefined);
			assert.equal(output.reason, undefined);
			assert.equal(output.systemMessage, undefined);
		} finally {
			await rm(cwd, { recursive: true, force: true });
		}
	});

	it("allows Ralplan Markdown draft-only apply_patch on the live CLI path while denying mixed targets", async () => {
		const cwd = await mkdtemp(
			join(tmpdir(), "omx-native-hook-cli-ralplan-draft-boundary-"),
		);
		const sessionId = "sess-cli-ralplan-draft-boundary";
		const stateDir = join(cwd, ".omx", "state");
		try {
			await writeJson(join(stateDir, "session.json"), {
				session_id: sessionId,
				cwd,
			});
			await writeJson(
				join(stateDir, "sessions", sessionId, "skill-active-state.json"),
				{
					active: true,
					skill: "ralplan",
					phase: "planning",
					session_id: sessionId,
					active_skills: [
						{
							skill: "ralplan",
							phase: "planning",
							active: true,
							session_id: sessionId,
						},
					],
				},
			);
			await writeJson(
				join(stateDir, "sessions", sessionId, "ralplan-state.json"),
				{
					active: true,
					mode: "ralplan",
					current_phase: "planning",
					session_id: sessionId,
				},
			);
			await writeCanonicalLeaderFixture(
				stateDir,
				sessionId,
				"thread-cli-ralplan-draft-boundary",
				cwd,
			);


			for (const [name, target] of [
				["relative", ".omx/drafts/issue-3105.md"],
				["repository-absolute", join(cwd, ".omx", "drafts", "issue-3105.md")],
			] as const) {
				const result = runNativeHookCliResult(
					{
						hook_event_name: "PreToolUse",
						cwd,
						session_id: sessionId,
						thread_id: "thread-cli-ralplan-draft-boundary",
						agent_id: "thread-cli-ralplan-draft-boundary",
						tool_name: "apply_patch",
						tool_input: {
							input: `*** Begin Patch\n*** Add File: ${target}\n+# Draft\n*** End Patch\n`,
						},
					},
					{ cwd },
				);

				assert.equal(result.status, 0, result.stderr || result.stdout);
				assert.deepEqual(parseSingleJsonStdout(result.stdout), {});
			}

			const mixedResult = runNativeHookCliResult(
				{
					hook_event_name: "PreToolUse",
					cwd,
					session_id: sessionId,
					thread_id: "thread-cli-ralplan-draft-boundary",
					agent_id: "thread-cli-ralplan-draft-boundary",
					tool_name: "apply_patch",
					tool_input: {
						input:
							"*** Begin Patch\n*** Add File: .omx/drafts/issue-3105.md\n+# Draft\n*** Add File: src/leak.ts\n+leak\n*** End Patch\n",
					},
				},
				{ cwd },
			);

			assert.equal(
				mixedResult.status,
				0,
				mixedResult.stderr || mixedResult.stdout,
			);
			const mixedOutput = parseSingleJsonStdout(mixedResult.stdout);
			const hookSpecificOutput = mixedOutput.hookSpecificOutput as Record<
				string,
				unknown
			>;
			assert.deepEqual(Object.keys(mixedOutput).sort(), ["hookSpecificOutput"]);
			assert.equal(hookSpecificOutput.hookEventName, "PreToolUse");
			assert.equal(hookSpecificOutput.permissionDecision, "deny");
			assert.match(
				String(hookSpecificOutput.permissionDecisionReason ?? ""),
				/src\/leak\.ts/,
			);
			assert.match(
				String(hookSpecificOutput.permissionDecisionReason ?? ""),
				/implementation\/write tools are blocked/,
			);
			assert.equal(mixedOutput.decision, undefined);
			assert.equal(mixedOutput.reason, undefined);
			assert.equal(mixedOutput.systemMessage, undefined);
		} finally {
			await rm(cwd, { recursive: true, force: true });
		}
	});

	it("rejects unauthenticated typed Team-worker claims before planning guards", async () => {
		const cwd = await mkdtemp(
			join(tmpdir(), "omx-native-hook-team-worker-typed-pretool-exempt-"),
		);
		const sessionId = "sess-team-worker-typed-pretool-exempt";
		const stateDir = join(cwd, ".omx", "state");
		const basePayload = {
			hook_event_name: "PreToolUse",
			cwd,
			session_id: sessionId,
			thread_id: "thread-team-worker-typed-pretool-exempt",
			agent_role: "executor",
			tool_name: "Edit",
			tool_use_id: "tool-team-worker-typed-pretool-exempt",
			tool_input: {
				file_path: "src/runtime.ts",
				old_string: "a",
				new_string: "b",
			},
		};
		try {
			await writeJson(join(stateDir, "session.json"), {
				session_id: sessionId,
			});
			await writeJson(
				join(stateDir, "sessions", sessionId, "skill-active-state.json"),
				{
					active: true,
					skill: "ralplan",
					phase: "planning",
					session_id: sessionId,
					active_skills: [
						{
							skill: "ralplan",
							phase: "planning",
							active: true,
							session_id: sessionId,
						},
					],
				},
			);
			await writeJson(
				join(stateDir, "sessions", sessionId, "ralplan-state.json"),
				{
					active: true,
					mode: "ralplan",
					current_phase: "critic-review",
					session_id: sessionId,
				},
			);

			const nonTeamWorkerTypedSubagent = await dispatchCodexNativeHook(
				basePayload,
				{ cwd },
			);
			assert.equal(
				(nonTeamWorkerTypedSubagent.outputJson as { decision?: string } | null)
					?.decision,
				"block",
				"typed/native subagent PreToolUse without trusted thread_spawn provenance must remain protected outside team workers",
			);

			process.env.OMX_TEAM_INTERNAL_WORKER = "typed-pretool-exempt/worker-1";
			process.env.OMX_TEAM_WORKER = "typed-pretool-exempt/worker-1";

			const teamWorkerTypedSubagent = await dispatchCodexNativeHook(
				basePayload,
				{ cwd },
			);
			assert.equal(
				(teamWorkerTypedSubagent.outputJson as { decision?: string } | null)
					?.decision,
				"block",
				"environment-only Team-worker claims must not bypass planning guards",
			);
		} finally {
			await rm(cwd, { recursive: true, force: true });
		}
	});

	it("preserves deep-interview PreToolUse planning guard as hook-specific deny JSON", async () => {
		const cwd = await mkdtemp(
			join(tmpdir(), "omx-native-hook-cli-deep-interview-pretool-boundary-"),
		);
		const sessionId = "sess-cli-deep-interview-pretool-boundary";
		const stateDir = join(cwd, ".omx", "state");
		try {
			await writeJson(join(stateDir, "session.json"), {
				session_id: sessionId,
			});
			await writeJson(
				join(stateDir, "sessions", sessionId, "skill-active-state.json"),
				{
					active: true,
					skill: "deep-interview",
					phase: "planning",
					session_id: sessionId,
					active_skills: [
						{
							skill: "deep-interview",
							phase: "planning",
							active: true,
							session_id: sessionId,
						},
					],
				},
			);
			await writeJson(
				join(stateDir, "sessions", sessionId, "deep-interview-state.json"),
				{
					active: true,
					mode: "deep-interview",
					current_phase: "intent-first",
					session_id: sessionId,
				},
			);

			const result = runNativeHookCliResult(
				{
					hook_event_name: "PreToolUse",
					cwd,
					session_id: sessionId,
					thread_id: "thread-cli-deep-interview-pretool-boundary",
					tool_name: "Write",
					tool_input: {
						file_path: "src/runtime.ts",
						content: "export const changed = true;\n",
					},
				},
				{ cwd },
			);

			assert.equal(result.status, 0, result.stderr || result.stdout);
			const output = parseSingleJsonStdout(result.stdout);
			const hookSpecificOutput = output.hookSpecificOutput as Record<
				string,
				unknown
			>;
			assert.deepEqual(Object.keys(output).sort(), ["hookSpecificOutput"]);
			assert.equal(hookSpecificOutput.hookEventName, "PreToolUse");
			assert.equal(hookSpecificOutput.permissionDecision, "deny");
			assert.match(
				String(hookSpecificOutput.permissionDecisionReason ?? ""),
				/Deep-interview is active \(phase: intent-first\)/,
			);
			assert.match(
				String(hookSpecificOutput.permissionDecisionReason ?? ""),
				/implementation\/write tools are blocked/,
			);
			assert.match(
				String(hookSpecificOutput.additionalContext ?? ""),
				/requirements\/spec mode/,
			);
			assert.equal(output.decision, undefined);
			assert.equal(output.reason, undefined);
			assert.equal(output.systemMessage, undefined);
		} finally {
			await rm(cwd, { recursive: true, force: true });
		}
	});

	it("synthesizes a deny for malformed explicit PreToolUse blocks instead of downgrading systemMessage to advisory", async () => {
		const cwd = await mkdtemp(
			join(tmpdir(), "omx-native-hook-cli-malformed-pretool-block-"),
		);
		try {
			for (const malformedBlockShape of ["legacy", "deny"] as const) {
				const result = runNativeHookCliResult(
					{
						hook_event_name: "PreToolUse",
						cwd,
						session_id: `sess-cli-malformed-pretool-${malformedBlockShape}`,
						thread_id: `thread-cli-malformed-pretool-${malformedBlockShape}`,
						tool_name: "Bash",
						tool_input: { command: "pwd" },
					},
					{
						cwd,
						env: {
							...process.env,
							NODE_ENV: "test",
							OMX_NATIVE_HOOK_TEST_MALFORMED_PRETOOL_BLOCK: malformedBlockShape,
						},
					},
				);

				assert.equal(result.status, 0, result.stderr || result.stdout);
				const output = parseSingleJsonStdout(result.stdout);
				const hookSpecificOutput = output.hookSpecificOutput as Record<
					string,
					unknown
				>;
				assert.deepEqual(Object.keys(output).sort(), [
					"hookSpecificOutput",
					"systemMessage",
				]);
				assert.equal(hookSpecificOutput.hookEventName, "PreToolUse");
				assert.equal(hookSpecificOutput.permissionDecision, "deny");
				assert.equal(
					hookSpecificOutput.permissionDecisionReason,
					String(output.systemMessage ?? "").trim(),
				);
			}
		} finally {
			await rm(cwd, { recursive: true, force: true });
		}
	});

	it("keeps wrapped ralplan implementation writes blocked at raw classification while allowing planning artifacts", async () => {
		const cwd = await mkdtemp(
			join(tmpdir(), "omx-native-hook-ralplan-wrapper-implementation-block-"),
		);
		const sessionId = "sess-ralplan-wrapper-implementation-block";
		const stateDir = join(cwd, ".omx", "state");
		try {
			await writeJson(join(stateDir, "session.json"), {
				session_id: sessionId,
			});
			await writeJson(
				join(stateDir, "sessions", sessionId, "skill-active-state.json"),
				{
					active: true,
					skill: "ralplan",
					phase: "planning",
					session_id: sessionId,
					active_skills: [
						{
							skill: "ralplan",
							phase: "planning",
							active: true,
							session_id: sessionId,
						},
					],
				},
			);
			await writeJson(
				join(stateDir, "sessions", sessionId, "ralplan-state.json"),
				{
					active: true,
					mode: "ralplan",
					current_phase: "critic-review",
					session_id: sessionId,
				},
			);
			await writeCanonicalLeaderFixture(
				stateDir,
				sessionId,
				"thread-ralplan-wrapper-implementation-block",
				cwd,
			);


			const blockedWrapperCommand =
				"bash -lc \"cat > src/scripts/__tests__/codex-native-hook.test.ts <<'EOF'\nexport const wrappedRalplanMutation = true;\nEOF\"";
			const blockedWrapper = await dispatchCodexNativeHook(
				{
					hook_event_name: "PreToolUse",
					cwd,
					session_id: sessionId,
					thread_id: "thread-ralplan-wrapper-implementation-block",
					agent_id: "thread-ralplan-wrapper-implementation-block",
					tool_name: "Bash",
					tool_use_id: "tool-ralplan-wrapper-implementation-block",
					tool_input: { command: blockedWrapperCommand },
				},
				{ cwd },
			);

			assert.equal(
				blockedWrapper.outputJson &&
					typeof blockedWrapper.outputJson === "object"
					? (blockedWrapper.outputJson as { decision?: string }).decision
					: undefined,
				"block",
			);
			assert.match(
				JSON.stringify(blockedWrapper.outputJson),
				/Ralplan is active \(phase: critic-review\)/,
			);
			assert.match(
				JSON.stringify(blockedWrapper.outputJson),
				/implementation\/write tools are blocked/,
			);

			const allowedPlanningArtifactWrite = await dispatchCodexNativeHook(
				{
					hook_event_name: "PreToolUse",
					cwd,
					session_id: sessionId,
					thread_id: "thread-ralplan-wrapper-implementation-block",
					agent_id: "thread-ralplan-wrapper-implementation-block",
					tool_name: "Write",
					tool_use_id: "tool-ralplan-wrapper-planning-artifact",
					tool_input: {
						file_path: ".omx/context/ralplan-wrapper-notes.md",
						content: "# Planning notes\n",
					},
				},
				{ cwd },
			);
			assert.equal(allowedPlanningArtifactWrite.outputJson, null);

			const allowedPlanningTmpWrite = await dispatchCodexNativeHook(
				{
					hook_event_name: "PreToolUse",
					cwd,
					session_id: sessionId,
					thread_id: "thread-ralplan-wrapper-implementation-block",
					agent_id: "thread-ralplan-wrapper-implementation-block",
					tool_name: "Write",
					tool_use_id: "tool-ralplan-wrapper-planning-tmp",
					tool_input: {
						file_path: ".omx/tmp/sess-ralplan-wrapper/notes.md",
						content: "# Scratch notes\n",
					},
				},
				{ cwd },
			);
			assert.equal(allowedPlanningTmpWrite.outputJson, null);

			const blockedPlanningTmpScriptWrite = await dispatchCodexNativeHook(
				{
					hook_event_name: "PreToolUse",
					cwd,
					session_id: sessionId,
					thread_id: "thread-ralplan-wrapper-implementation-block",
					tool_name: "Write",
					tool_use_id: "tool-ralplan-wrapper-planning-tmp-script-write",
					tool_input: {
						file_path: ".omx/tmp/sess-ralplan-wrapper/run.sh",
						content: "printf pwned > src/pwned.ts\n",
					},
				},
				{ cwd },
			);
			assert.equal(
				(
					blockedPlanningTmpScriptWrite.outputJson as {
						decision?: string;
					} | null
				)?.decision,
				"block",
			);
			assert.match(
				JSON.stringify(blockedPlanningTmpScriptWrite.outputJson),
				/\.omx\/tmp|planning artifact paths/,
			);

			const blockedPlanningTmpScriptExecution = await dispatchCodexNativeHook(
				{
					hook_event_name: "PreToolUse",
					cwd,
					session_id: sessionId,
					thread_id: "thread-ralplan-wrapper-implementation-block",
					tool_name: "Bash",
					tool_use_id: "tool-ralplan-wrapper-planning-tmp-script-exec",
					tool_input: { command: "sh .omx/tmp/sess-ralplan-wrapper/run.sh" },
				},
				{ cwd },
			);
			assert.equal(
				(
					blockedPlanningTmpScriptExecution.outputJson as {
						decision?: string;
					} | null
				)?.decision,
				"block",
			);
			assert.match(
				JSON.stringify(blockedPlanningTmpScriptExecution.outputJson),
				/generated-script transport|\.omx\/tmp/,
			);

			const blockedPlanningTmpExtensionlessExecution =
				await dispatchCodexNativeHook(
					{
						hook_event_name: "PreToolUse",
						cwd,
						session_id: sessionId,
						thread_id: "thread-ralplan-wrapper-implementation-block",
						tool_name: "Bash",
						tool_use_id: "tool-ralplan-wrapper-planning-tmp-extensionless-exec",
						tool_input: {
							command: "./.omx/tmp/sess-ralplan-wrapper/generated",
						},
					},
					{ cwd },
				);
			assert.equal(
				(
					blockedPlanningTmpExtensionlessExecution.outputJson as {
						decision?: string;
					} | null
				)?.decision,
				"block",
			);
			assert.match(
				JSON.stringify(blockedPlanningTmpExtensionlessExecution.outputJson),
				/generated-script transport|\.omx\/tmp/,
			);

			const blockedPlanningTmpVersionedInterpreterExecution =
				await dispatchCodexNativeHook(
					{
						hook_event_name: "PreToolUse",
						cwd,
						session_id: sessionId,
						thread_id: "thread-ralplan-wrapper-implementation-block",
						tool_name: "Bash",
						tool_use_id:
							"tool-ralplan-wrapper-planning-tmp-versioned-python-exec",
						tool_input: {
							command: "python3.12 .omx/tmp/sess-ralplan-wrapper/generated.txt",
						},
					},
					{ cwd },
				);
			assert.equal(
				(
					blockedPlanningTmpVersionedInterpreterExecution.outputJson as {
						decision?: string;
					} | null
				)?.decision,
				"block",
			);
			assert.match(
				JSON.stringify(
					blockedPlanningTmpVersionedInterpreterExecution.outputJson,
				),
				/generated-script transport|\.omx\/tmp/,
			);

			const blockedPlanningTmpTsxExecution = await dispatchCodexNativeHook(
				{
					hook_event_name: "PreToolUse",
					cwd,
					session_id: sessionId,
					thread_id: "thread-ralplan-wrapper-implementation-block",
					tool_name: "Bash",
					tool_use_id: "tool-ralplan-wrapper-planning-tmp-tsx-exec",
					tool_input: {
						command: "tsx .omx/tmp/sess-ralplan-wrapper/generated.ts",
					},
				},
				{ cwd },
			);
			assert.equal(
				(
					blockedPlanningTmpTsxExecution.outputJson as {
						decision?: string;
					} | null
				)?.decision,
				"block",
			);
			assert.match(
				JSON.stringify(blockedPlanningTmpTsxExecution.outputJson),
				/generated-script transport|\.omx\/tmp/,
			);

			const blockedPlanningTmpTsxWithOptionsExecution =
				await dispatchCodexNativeHook(
					{
						hook_event_name: "PreToolUse",
						cwd,
						session_id: sessionId,
						thread_id: "thread-ralplan-wrapper-implementation-block",
						tool_name: "Bash",
						tool_use_id: "tool-ralplan-wrapper-planning-tmp-tsx-options-exec",
						tool_input: {
							command:
								"tsx --tsconfig tsconfig.json watch .omx/tmp/sess-ralplan-wrapper/generated.ts",
						},
					},
					{ cwd },
				);
			assert.equal(
				(
					blockedPlanningTmpTsxWithOptionsExecution.outputJson as {
						decision?: string;
					} | null
				)?.decision,
				"block",
			);
			assert.match(
				JSON.stringify(blockedPlanningTmpTsxWithOptionsExecution.outputJson),
				/generated-script transport|\.omx\/tmp/,
			);

			const allowedBeadsMetadataWrite = await dispatchCodexNativeHook(
				{
					hook_event_name: "PreToolUse",
					cwd,
					session_id: sessionId,
					thread_id: "thread-ralplan-wrapper-implementation-block",
					tool_name: "Write",
					tool_use_id: "tool-ralplan-wrapper-beads-metadata",
					tool_input: {
						file_path: ".beads/ralplan-wrapper.json",
						content: "{}\n",
					},
				},
				{ cwd },
			);
			assert.equal(allowedBeadsMetadataWrite.outputJson, null);

			const allowedQuotedMention = await dispatchCodexNativeHook(
				{
					hook_event_name: "PreToolUse",
					cwd,
					session_id: sessionId,
					thread_id: "thread-ralplan-wrapper-implementation-block",
					tool_name: "Bash",
					tool_use_id: "tool-ralplan-wrapper-quoted-mention",
					tool_input: {
						command:
							"printf '%s\\n' 'src/scripts/__tests__/codex-native-hook.test.ts'",
					},
				},
				{ cwd },
			);
			assert.equal(allowedQuotedMention.outputJson, null);


			const blockedPythonPlanningArtifactExecution =
				await dispatchCodexNativeHook(
					{
						hook_event_name: "PreToolUse",
						cwd,
						session_id: sessionId,
						thread_id: "thread-ralplan-wrapper-implementation-block",
						tool_name: "Bash",
						tool_use_id: "tool-ralplan-wrapper-python-planning-artifact-exec",
						tool_input: {
							command: `python3 - <<'PY'
from pathlib import Path
Path('.omx/plans/run.sh').write_text('echo ran')
PY
sh .omx/plans/run.sh`,
						},
					},
					{ cwd },
				);
			assert.equal(
				blockedPythonPlanningArtifactExecution.outputJson &&
					typeof blockedPythonPlanningArtifactExecution.outputJson === "object"
					? (
							blockedPythonPlanningArtifactExecution.outputJson as {
								decision?: string;
							}
						).decision
					: undefined,
				"block",
			);
			assert.match(
				JSON.stringify(blockedPythonPlanningArtifactExecution.outputJson),
				/same-command|Bash write intent|implementation/i,
			);

			const blockedPythonAllowedMkdirDynamicSourceWrite =
				await dispatchCodexNativeHook(
					{
						hook_event_name: "PreToolUse",
						cwd,
						session_id: sessionId,
						thread_id: "thread-ralplan-wrapper-implementation-block",
						tool_name: "Bash",
						tool_use_id:
							"tool-ralplan-wrapper-python-allowed-mkdir-dynamic-source-write",
						tool_input: {
							command: `python3 - <<'PY'
from pathlib import Path
Path('.omx/plans').mkdir(parents=True, exist_ok=True)
(Path('src') / 'generated.ts').write_text('implementation')
PY`,
						},
					},
					{ cwd },
				);
			assert.equal(
				blockedPythonAllowedMkdirDynamicSourceWrite.outputJson &&
					typeof blockedPythonAllowedMkdirDynamicSourceWrite.outputJson ===
						"object"
					? (
							blockedPythonAllowedMkdirDynamicSourceWrite.outputJson as {
								decision?: string;
							}
						).decision
					: undefined,
				"block",
			);
			assert.match(
				JSON.stringify(blockedPythonAllowedMkdirDynamicSourceWrite.outputJson),
				/write intent did not identify an allowed planning artifact path/,
			);

			const blockedPythonSourceWrite = await dispatchCodexNativeHook(
				{
					hook_event_name: "PreToolUse",
					cwd,
					session_id: sessionId,
					thread_id: "thread-ralplan-wrapper-implementation-block",
					tool_name: "Bash",
					tool_use_id: "tool-ralplan-wrapper-python-source-write",
					tool_input: {
						command: `python3 - <<'PY'
from pathlib import Path
Path('src/generated.ts').write_text('implementation')
PY`,
					},
				},
				{ cwd },
			);
			assert.equal(
				blockedPythonSourceWrite.outputJson &&
					typeof blockedPythonSourceWrite.outputJson === "object"
					? (blockedPythonSourceWrite.outputJson as { decision?: string })
							.decision
					: undefined,
				"block",
			);
			assert.match(
				JSON.stringify(blockedPythonSourceWrite.outputJson),
				/Bash .* target src\/generated\.ts/,
			);

			const blockedPythonMixedWrite = await dispatchCodexNativeHook(
				{
					hook_event_name: "PreToolUse",
					cwd,
					session_id: sessionId,
					thread_id: "thread-ralplan-wrapper-implementation-block",
					tool_name: "Bash",
					tool_use_id: "tool-ralplan-wrapper-python-mixed-write",
					tool_input: {
						command: `python3 - <<'PY'
from pathlib import Path
Path('.omx/plans/rebase-pr3010-ultragoal-fix-plan.md').write_text('planning text')
Path('src/generated.ts').write_text('implementation')
PY`,
					},
				},
				{ cwd },
			);
			assert.equal(
				blockedPythonMixedWrite.outputJson &&
					typeof blockedPythonMixedWrite.outputJson === "object"
					? (blockedPythonMixedWrite.outputJson as { decision?: string })
							.decision
					: undefined,
				"block",
			);
			assert.match(
				JSON.stringify(blockedPythonMixedWrite.outputJson),
				/Bash .* target src\/generated\.ts/,
			);
		} finally {
			await rm(cwd, { recursive: true, force: true });
		}
	});

	it("blocks deep-interview PreToolUse implementation writes when terminal Autopilot run-state shadows stale active state", async () => {
		const cwd = await mkdtemp(
			join(tmpdir(), "omx-native-hook-deep-interview-terminal-pretool-"),
		);
		try {
			const stateDir = join(cwd, ".omx", "state");
			const sessionId = "sess-deep-interview-terminal-pretool";
			await mkdir(join(stateDir, "sessions", sessionId), { recursive: true });
			await writeJson(join(stateDir, "session.json"), {
				session_id: sessionId,
			});
			await writeJson(
				join(stateDir, "sessions", sessionId, "skill-active-state.json"),
				{
					active: true,
					skill: "deep-interview",
					phase: "planning",
					session_id: sessionId,
					active_skills: [
						{
							skill: "deep-interview",
							phase: "planning",
							active: true,
							session_id: sessionId,
						},
					],
				},
			);
			await writeJson(
				join(stateDir, "sessions", sessionId, "deep-interview-state.json"),
				{
					active: true,
					mode: "deep-interview",
					current_phase: "intent-first",
					session_id: sessionId,
				},
			);
			await writeJson(join(stateDir, "sessions", sessionId, "run-state.json"), {
				version: 1,
				active: false,
				mode: "autopilot",
				outcome: "finish",
				lifecycle_outcome: "finished",
				current_phase: "complete",
				completed_at: "2026-05-30T00:00:00.000Z",
				updated_at: "2026-05-30T00:00:00.000Z",
			});

			const result = await dispatchCodexNativeHook(
				{
					hook_event_name: "PreToolUse",
					cwd,
					session_id: sessionId,
					thread_id: "thread-deep-interview-terminal-pretool",
					tool_name: "Edit",
					tool_input: { file_path: "src/runtime.ts" },
				},
				{ cwd },
			);

			assert.equal(result.omxEventName, "pre-tool-use");
			assert.equal(
				(result.outputJson as { decision?: string } | null)?.decision,
				"block",
			);
			assert.match(
				JSON.stringify(result.outputJson),
				/Deep-interview is active \(phase: intent-first\)/,
			);
			assert.match(
				JSON.stringify(result.outputJson),
				/implementation\/write tools are blocked/,
			);
		} finally {
			await rm(cwd, { recursive: true, force: true });
		}
	});

	it("emits parseable no-op JSON stdout for inactive Stop CLI runs", async () => {
		const cwd = await mkdtemp(
			join(tmpdir(), "omx-native-hook-cli-stop-noop-json-"),
		);
		try {
			const stdout = runNativeHookCli(
				{
					hook_event_name: "Stop",
					cwd,
					session_id: "sess-cli-stop-noop-json",
					thread_id: "thread-cli-stop-noop-json",
					turn_id: "turn-cli-stop-noop-json",
				},
				{ cwd },
			);
			const output = parseSingleJsonStdout(stdout);

			assert.deepEqual(output, {});
			assert.equal(existsSync(join(cwd, ".omx", "state")), false);
		} finally {
			await rm(cwd, { recursive: true, force: true });
		}
	});

	it("emits no-op JSON stdout for Stop payloads with no runtime output", async () => {
		const cwd = await mkdtemp(
			join(tmpdir(), "omx-native-hook-cli-stop-null-output-"),
		);
		try {
			const result = spawnSync(process.execPath, [nativeHookScriptPath()], {
				cwd,
				input: JSON.stringify({
					hook_event_name: "Stop",
					cwd,
					session_id: "sess-cli-stop-null-output",
					thread_id: "thread-cli-stop-null-output",
					turn_id: "turn-cli-stop-null-output",
					stop_hook_active: true,
				}),
				encoding: "utf-8",
				stdio: ["pipe", "pipe", "pipe"],
			});

			assert.equal(result.status, 0, result.stderr || result.stdout);
			assert.equal(result.stderr, "");
			assert.deepEqual(parseSingleJsonStdout(result.stdout), {});
			assert.equal(existsSync(join(cwd, ".omx", "state")), false);
		} finally {
			await rm(cwd, { recursive: true, force: true });
		}
	});

	it("emits no-op JSON for oversized Stop stdin without parsing or creating inactive state", async () => {
		const cwd = await mkdtemp(
			join(tmpdir(), "omx-native-hook-cli-stop-oversized-"),
		);
		try {
			const oversizedStop = JSON.stringify({
				hook_event_name: "Stop",
				cwd,
				session_id: "sess-cli-stop-oversized",
				transcript: "x".repeat(MAX_NATIVE_STDIN_JSON_BYTES + 1),
			});

			const stdout = runNativeHookCli(oversizedStop, { cwd });
			assert.deepEqual(parseSingleJsonStdout(stdout), {});
			assert.equal(existsSync(join(cwd, ".omx", "state")), false);
		} finally {
			await rm(cwd, { recursive: true, force: true });
		}
	});

	it("drains oversized stdin without breaking the parent writer pipe", async () => {
		const child = spawn(process.execPath, [nativeHookScriptPath()], {
			stdio: ["pipe", "ignore", "ignore"],
		});
		const payload = JSON.stringify({
			hook_event_name: "UserPromptSubmit",
			prompt: "x".repeat(MAX_NATIVE_STDIN_JSON_BYTES * 2),
		});
		const exitCode = new Promise<number | null>((resolve) => {
			child.once("close", resolve);
		});
		const writeError = await new Promise<Error | null>((resolve) => {
			child.stdin.once("error", resolve);
			child.stdin.end(payload, () => resolve(null));
		});

		assert.equal(writeError, null);
		assert.equal(await exitCode, 0);
	});

	it("blocks oversized Stop stdin when current session autopilot is active", async () => {
		const cwd = await mkdtemp(
			join(tmpdir(), "omx-native-hook-cli-stop-oversized-active-"),
		);
		try {
			await writeActiveAutopilotSession(cwd, "sess-cli-stop-oversized-active");
			const oversizedStop = JSON.stringify({
				hook_event_name: "Stop",
				cwd,
				session_id: "native-session-hidden-by-oversized-payload",
				transcript: "x".repeat(MAX_NATIVE_STDIN_JSON_BYTES + 1),
			});

			const output = parseSingleJsonStdout(
				runNativeHookCli(oversizedStop, { cwd }),
			) as {
				decision?: string;
				stopReason?: string;
				systemMessage?: string;
			};
			assert.equal(output.decision, "block");
			assert.equal(
				output.stopReason,
				"native_stop_stdin_oversized_active_workflow",
			);
			assert.match(
				String(output.systemMessage ?? ""),
				/active current-session workflow state/,
			);
			assert.equal(existsSync(join(cwd, ".omx", "logs")), false);
		} finally {
			await rm(cwd, { recursive: true, force: true });
		}
	});

	it("emits no-op JSON for oversized Stop stdin for unrelated root autopilot state", async () => {
		const cwd = await mkdtemp(
			join(tmpdir(), "omx-native-hook-cli-stop-oversized-stale-root-"),
		);
		try {
			await writeJson(join(cwd, ".omx", "state", "session.json"), {
				session_id: "sess-current-without-active-autopilot",
				cwd,
			});
			await writeJson(join(cwd, ".omx", "state", "autopilot-state.json"), {
				active: true,
				current_phase: "execution",
			});
			const oversizedStop = JSON.stringify({
				hook_event_name: "Stop",
				cwd,
				transcript: "x".repeat(MAX_NATIVE_STDIN_JSON_BYTES + 1),
			});

			assert.deepEqual(
				parseSingleJsonStdout(runNativeHookCli(oversizedStop, { cwd })),
				{},
			);
			assert.equal(existsSync(join(cwd, ".omx", "logs")), false);
		} finally {
			await rm(cwd, { recursive: true, force: true });
		}
	});

	it("emits no-op JSON for oversized Stop stdin when terminal run-state shadows stale autopilot state", async () => {
		const cwd = await mkdtemp(
			join(tmpdir(), "omx-native-hook-cli-stop-oversized-terminal-run-"),
		);
		try {
			const sessionId = "sess-cli-stop-oversized-terminal-run";
			await writeActiveAutopilotSession(cwd, sessionId);
			await writeJson(
				join(cwd, ".omx", "state", "sessions", sessionId, "run-state.json"),
				{
					version: 1,
					active: false,
					mode: "autopilot",
					outcome: "finish",
					lifecycle_outcome: "finished",
					current_phase: "complete",
					completed_at: "2026-05-20T11:00:00.000Z",
					updated_at: "2026-05-20T11:00:00.000Z",
				},
			);
			const oversizedStop = JSON.stringify({
				hook_event_name: "Stop",
				cwd,
				transcript: "x".repeat(MAX_NATIVE_STDIN_JSON_BYTES + 1),
			});

			assert.deepEqual(
				parseSingleJsonStdout(runNativeHookCli(oversizedStop, { cwd })),
				{},
			);
			assert.equal(existsSync(join(cwd, ".omx", "logs")), false);
		} finally {
			await rm(cwd, { recursive: true, force: true });
		}
	});

	it("accepts exact UTF-8 byte-limit PreToolUse and PostToolUse payloads and rejects only larger input", () => {
		for (const eventName of ["PreToolUse", "PostToolUse"] as const) {
			for (const byteLength of [MAX_NATIVE_STDIN_JSON_BYTES - 1, MAX_NATIVE_STDIN_JSON_BYTES]) {
				const result = runNativeHookCliResult(buildExactByteHookPayload(eventName, byteLength));
				assert.equal(result.status, 0, result.stderr || result.stdout);
				assert.doesNotMatch(result.stdout, /native_hook_stdin_oversized/);
			}
			const result = runNativeHookCliResult(buildExactByteHookPayload(eventName, MAX_NATIVE_STDIN_JSON_BYTES + 1));
			assert.equal(result.status, 0, result.stderr || result.stdout);
			assert.equal(result.stderr, "");
			const expected = eventName === "PreToolUse"
				? {
					systemMessage: OVERSIZED_STDIN_SYSTEM_MESSAGE,
					hookSpecificOutput: {
						hookEventName: "PreToolUse",
						permissionDecision: "deny",
						permissionDecisionReason: OVERSIZED_STDIN_SYSTEM_MESSAGE,
					},
				}
				: {
					continue: false,
					stopReason: "native_hook_stdin_oversized",
					systemMessage: OVERSIZED_STDIN_SYSTEM_MESSAGE,
				};
			assert.deepEqual(parseSingleJsonStdout(result.stdout), expected);
		}
	});

	it("fails closed for oversized non-Stop stdin before parsing", async () => {
		const cwd = await mkdtemp(
			join(tmpdir(), "omx-native-hook-cli-nonstop-oversized-"),
		);
		try {
			const oversizedPrompt = JSON.stringify({
				hook_event_name: "UserPromptSubmit",
				cwd,
				session_id: "sess-cli-prompt-oversized",
				prompt: "x".repeat(MAX_NATIVE_STDIN_JSON_BYTES + 1),
			});

			const output = parseSingleJsonStdout(
				runNativeHookCli(oversizedPrompt, { cwd }),
			) as {
				continue?: boolean;
				stopReason?: string;
				systemMessage?: string;
			};
			assert.equal(output.continue, false);
			assert.equal(output.stopReason, "native_hook_stdin_oversized");
			assert.match(
				String(output.systemMessage ?? ""),
				/rejected oversized stdin JSON before parsing/,
			);
		} finally {
			await rm(cwd, { recursive: true, force: true });
		}
	});


	it("runs prompt-submit HUD reconciliation as a best-effort tmux-only side effect", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "omx-native-hook-hud-reconcile-"));
		const originalTmux = process.env.TMUX;
		const originalTmuxPane = process.env.TMUX_PANE;
		const originalPath = process.env.PATH;
		const originalHudOwner = process.env[OMX_TMUX_HUD_OWNER_ENV];
		const originalArgv = process.argv;
		try {
			process.env.TMUX = "1";
			process.env.TMUX_PANE = "%1";
			process.env[OMX_TMUX_HUD_OWNER_ENV] = "1";
			await mkdir(join(cwd, ".omx", "state"), { recursive: true });
			await writeFile(
				join(cwd, ".omx", "hud-config.json"),
				JSON.stringify(
					{ preset: "focused", git: { display: "branch" } },
					null,
					2,
				),
			);

			const binDir = await mkdtemp(
				join(tmpdir(), "omx-native-hook-hud-reconcile-bin-"),
			);
			const tmuxLog = join(cwd, "tmux.log");
			await writeFile(
				join(binDir, "tmux"),
`#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >> ${JSON.stringify(tmuxLog)}
options_file=${JSON.stringify(join(cwd, "tmux-options"))}
state_file=${JSON.stringify(join(cwd, "tmux-state"))}
if [[ -f "$state_file" ]]; then
  IFS=$'\t' read -r panes marker < "$state_file"
else
  panes='%1'
  marker=''
fi
case "$1" in
  list-panes)
    if [[ "$*" == *'#{pane_id} #{pane_dead} #{pane_pid}'* ]]; then
      printf '%%1 0 200\n'
      [[ "$panes" == *'%9'* ]] && printf '%%9 0 201\n'
    elif [[ "$*" == *'pane_start_command'* ]]; then
      printf '%%1\t/bin/codex\n'
      [[ "$panes" == *'%9'* ]] && printf '%%9\tOMX_TMUX_SPLIT_OPERATION_MARKER='"'"'"$marker'"'"'; export OMX_TMUX_SPLIT_OPERATION_MARKER; node dist/cli/omx.js hud --watch\n'
    elif [[ "$panes" == *'%9'* ]]; then
      printf '%%1\n%%9\n'
    else
      printf '%%1\n'
    fi
    ;;
  display-message)
    if [[ "$*" == *'#{pane_id}'*'#{pane_dead}'*'#{pane_pid}'*'#{session_id}'*'#{window_id}'* ]]; then
      printf '%%1\t0\t200\t$1\t@1\n'
    elif [[ "$*" == *'#{session_id}'*'#{window_id}'* ]]; then
      printf '$1\t@1\n'
    else
      printf '200\t60\n'
    fi
    ;;
  set-option)
    printf '%s\t%s\n' "$3" "$4" >> "$options_file"
    ;;
  show-options)
    value=''
    if [[ -f "$options_file" ]]; then
      while IFS=$'\t' read -r key stored; do
        [[ "$key" == "$4" ]] && value="$stored"
      done < "$options_file"
    fi
    printf '%s\n' "$value"
    ;;
  if-shell)
    success="$6"
    if [[ "$success" == *'split-window'* ]]; then
      if [[ "$success" =~ OMX_TMUX_SPLIT_OPERATION_MARKER=\\'([^\\']+)\\' ]]; then
        marker="\${BASH_REMATCH[1]}"
      fi
panes='%1 %9'
printf '%s\t%s\n' "$panes" "$marker" > "$state_file"
    fi
    receipt="\${success#*display-message -p }"
    if [[ "$receipt" != "$success" ]]; then
      receipt="\${receipt%%[[:space:]]*}"
      printf '%s\n' "$receipt"
    fi
    ;;
  resize-pane)
    ;;
esac
`
			);
			await chmod(join(binDir, "tmux"), 0o755);
			const tmuxSyntax = spawnSync("bash", ["-n", join(binDir, "tmux")], {
				encoding: "utf-8",
			});
			assert.equal(tmuxSyntax.status, 0, tmuxSyntax.stderr);
			process.env.PATH = `${binDir}:${originalPath}`;
			process.argv = [originalArgv[0] || "node", "/tmp/codex-host-binary"];

			const result = await dispatchCodexNativeHook(
				{
					hook_event_name: "UserPromptSubmit",
					cwd,
					session_id: "sess-hud-1",
					prompt: "$ralplan prepare plan",
				},
				{ cwd },
			);

			assert.equal(result.omxEventName, "keyword-detector");
			const tmuxCalls = await readFile(tmuxLog, "utf-8");
			assert.match(tmuxCalls, /list-panes -t %1 -F/);
			assert.match(
				tmuxCalls,
				new RegExp(`if-shell -F -t %1 [^\\n]*#\\{pane_pid\\},200[^\\n]*#\\{session_id\\},\\$1[^\\n]*#\\{window_id\\},@1[^\\n]*split-window -v -l ${HUD_TMUX_HEIGHT_LINES} -d -t %1 [^\\n]*display-message -p __omx_hud_split_`),
			);
			assert.match(
				tmuxCalls,
				/dist\/cli\/omx\.js'\\'' hud --watch '\\''--preset=focused'\\'''/,
			);
			assert.doesNotMatch(tmuxCalls, /\/tmp\/codex-host-binary' hud --watch/);
		} finally {
			if (originalTmux === undefined) {
				delete process.env.TMUX;
			} else {
				process.env.TMUX = originalTmux;
			}
			if (originalTmuxPane === undefined) {
				delete process.env.TMUX_PANE;
			} else {
				process.env.TMUX_PANE = originalTmuxPane;
			}
			if (originalHudOwner === undefined) {
				delete process.env[OMX_TMUX_HUD_OWNER_ENV];
			} else {
				process.env[OMX_TMUX_HUD_OWNER_ENV] = originalHudOwner;
			}
			process.env.PATH = originalPath;
			process.argv = originalArgv;
			await rm(cwd, { recursive: true, force: true });
		}
	});

	it("skips prompt-submit HUD reconciliation during doctor smoke validation", async () => {
		const cwd = await mkdtemp(
			join(tmpdir(), "omx-native-hook-doctor-smoke-hud-"),
		);
		const originalTmux = process.env.TMUX;
		const originalTmuxPane = process.env.TMUX_PANE;
		const originalHudOwner = process.env[OMX_TMUX_HUD_OWNER_ENV];
		const originalDoctorSmoke = process.env.OMX_NATIVE_HOOK_DOCTOR_SMOKE;
		try {
			process.env.TMUX = "1";
			process.env.TMUX_PANE = "%1";
			process.env[OMX_TMUX_HUD_OWNER_ENV] = "1";
			process.env.OMX_NATIVE_HOOK_DOCTOR_SMOKE = "1";

			let reconcileCalled = false;
			const result = await dispatchCodexNativeHook(
				{
					hook_event_name: "UserPromptSubmit",
					cwd,
					session_id: "omx-doctor-plugin-hook-smoke",
					prompt: "$ralplan doctor plugin hook smoke test",
				},
				{
					cwd,
					reconcileHudForPromptSubmitFn: async () => {
						reconcileCalled = true;
						return {
							status: "recreated",
							paneId: "%9",
							desiredHeight: 3,
							duplicateCount: 0,
						};
					},
				},
			);

			assert.equal(result.omxEventName, "keyword-detector");
			assert.equal(reconcileCalled, false);
		} finally {
			if (originalTmux === undefined) delete process.env.TMUX;
			else process.env.TMUX = originalTmux;
			if (originalTmuxPane === undefined) delete process.env.TMUX_PANE;
			else process.env.TMUX_PANE = originalTmuxPane;
			if (originalHudOwner === undefined)
				delete process.env[OMX_TMUX_HUD_OWNER_ENV];
			else process.env[OMX_TMUX_HUD_OWNER_ENV] = originalHudOwner;
			if (originalDoctorSmoke === undefined)
				delete process.env.OMX_NATIVE_HOOK_DOCTOR_SMOKE;
			else process.env.OMX_NATIVE_HOOK_DOCTOR_SMOKE = originalDoctorSmoke;
			await rm(cwd, { recursive: true, force: true });
		}
	});




});
describe("Stop transcript-backed recovery for a stale-dead selected pointer (issue #3427)", { concurrency: false }, () => {
  async function writeStaleDeadStopFixture(
    cwd: string,
    sessionId: string,
    options: { transcript?: boolean; sessionDir?: boolean; pointer?: Record<string, unknown> } = {},
  ): Promise<{ stateDir: string; transcriptPath: string; pointerBefore: string }> {
    const stateDir = join(cwd, ".omx", "state");
    await mkdir(stateDir, { recursive: true });
    await writeJson(join(stateDir, "session.json"), {
      session_id: sessionId,
      cwd,
      pid: 2_147_483_647,
      ...options.pointer,
    });
    const pointerBefore = await readFile(join(stateDir, "session.json"), "utf-8");
    const transcriptPath = join(cwd, `rollout-${sessionId}.jsonl`);
    if (options.transcript !== false) {
      await writeFile(
        transcriptPath,
        `${JSON.stringify({
          type: "session_meta",
          payload: { id: sessionId, session_id: sessionId, cwd, timestamp: "2026-08-03T00:00:00.000Z" },
        })}\n`,
      );
    }
    if (options.sessionDir !== false) {
      await mkdir(join(stateDir, "sessions", sessionId), { recursive: true });
    }
    return { stateDir, transcriptPath, pointerBefore };
  }

  async function writeSessionScopedModeState(cwd: string, sessionId: string, mode: string): Promise<void> {
    const stateDir = join(cwd, ".omx", "state");
    await writeJson(join(stateDir, "sessions", sessionId, `${mode}-state.json`), {
      active: true,
      mode,
      current_phase: "executing",
      session_id: sessionId,
      workingDirectory: cwd,
    });
  }

  it("authorizes an exact stale-dead Stop through the payload transcript and evaluates session-scoped state", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omx-3427-transcript-recovery-"));
    try {
      const sessionId = "live-session-3427";
      const { stateDir, transcriptPath, pointerBefore } = await writeStaleDeadStopFixture(cwd, sessionId);
      await writeSessionScopedModeState(cwd, sessionId, "autopilot");

      const first = await dispatchCodexNativeHook({
        hook_event_name: "Stop",
        cwd,
        session_id: sessionId,
        transcript_path: transcriptPath,
        turn_id: "3427-stop-turn",
      }, { cwd });

      assert.equal(first.outputJson?.decision, "block");
      assert.equal(first.outputJson?.stopReason, "autopilot_executing");
      assert.equal(await readFile(join(stateDir, "session.json"), "utf-8"), pointerBefore);
      assert.equal(existsSync(join(stateDir, "native-stop-state.json")), false);

      // The recovery is read-only, so a repeated Stop is idempotent.
      const second = await dispatchCodexNativeHook({
        hook_event_name: "Stop",
        cwd,
        session_id: sessionId,
        transcript_path: transcriptPath,
        turn_id: "3427-stop-turn-2",
      }, { cwd });
      assert.equal(second.outputJson?.stopReason, "autopilot_executing");
      assert.equal(await readFile(join(stateDir, "session.json"), "utf-8"), pointerBefore);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("authorizes the exact stale-dead Stop as a clean no-op when no session-scoped state is active", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omx-3427-transcript-clean-stop-"));
    try {
      const sessionId = "clean-live-session-3427";
      const { stateDir, transcriptPath, pointerBefore } = await writeStaleDeadStopFixture(cwd, sessionId);

      const result = await dispatchCodexNativeHook({
        hook_event_name: "Stop",
        cwd,
        session_id: sessionId,
        transcript_path: transcriptPath,
      }, { cwd });

      assert.equal(result.outputJson, null);
      assert.equal(await readFile(join(stateDir, "session.json"), "utf-8"), pointerBefore);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("fails closed for a foreign transcript cwd", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omx-3427-foreign-cwd-"));
    try {
      const sessionId = "foreign-cwd-session-3427";
      const foreignCwd = join(tmpdir(), "omx-3427-unrelated-repo");
      await mkdir(foreignCwd, { recursive: true });
      const { stateDir, pointerBefore } = await writeStaleDeadStopFixture(cwd, sessionId, { sessionDir: false });
      await mkdir(join(stateDir, "sessions", sessionId), { recursive: true });
      const transcriptPath = join(cwd, `rollout-${sessionId}.jsonl`);
      await writeFile(
        transcriptPath,
        `${JSON.stringify({
          type: "session_meta",
          payload: { id: sessionId, session_id: sessionId, cwd: foreignCwd },
        })}\n`,
      );

      const result = await dispatchCodexNativeHook({
        hook_event_name: "Stop",
        cwd,
        session_id: sessionId,
        transcript_path: transcriptPath,
      }, { cwd });

      assert.equal(result.outputJson, null);
      assert.equal(await readFile(join(stateDir, "session.json"), "utf-8"), pointerBefore);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("fails closed when the transcript session_meta id does not match the payload session", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omx-3427-mismatched-id-"));
    try {
      const sessionId = "mismatch-session-3427";
      const { stateDir, pointerBefore } = await writeStaleDeadStopFixture(cwd, sessionId, { sessionDir: false });
      await mkdir(join(stateDir, "sessions", sessionId), { recursive: true });
      const transcriptPath = join(cwd, `rollout-${sessionId}.jsonl`);
      await writeFile(
        transcriptPath,
        `${JSON.stringify({
          type: "session_meta",
          payload: { id: "some-other-session", session_id: sessionId, cwd },
        })}\n`,
      );

      const result = await dispatchCodexNativeHook({
        hook_event_name: "Stop",
        cwd,
        session_id: sessionId,
        transcript_path: transcriptPath,
      }, { cwd });

      assert.equal(result.outputJson, null);
      assert.equal(await readFile(join(stateDir, "session.json"), "utf-8"), pointerBefore);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("fails closed when the transcript filename is not bound to the session id", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omx-3427-filename-binding-"));
    try {
      const sessionId = "filename-bound-session-3427";
      const { stateDir, pointerBefore } = await writeStaleDeadStopFixture(cwd, sessionId, { sessionDir: false });
      await mkdir(join(stateDir, "sessions", sessionId), { recursive: true });
      const transcriptPath = join(cwd, "rollout-unrelated.jsonl");
      await writeFile(
        transcriptPath,
        `${JSON.stringify({
          type: "session_meta",
          payload: { id: sessionId, session_id: sessionId, cwd },
        })}\n`,
      );

      const result = await dispatchCodexNativeHook({
        hook_event_name: "Stop",
        cwd,
        session_id: sessionId,
        transcript_path: transcriptPath,
      }, { cwd });

      assert.equal(result.outputJson, null);
      assert.equal(await readFile(join(stateDir, "session.json"), "utf-8"), pointerBefore);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("fails closed for a relative transcript path", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omx-3427-relative-transcript-"));
    try {
      const sessionId = "relative-transcript-session-3427";
      const { stateDir, pointerBefore } = await writeStaleDeadStopFixture(cwd, sessionId, { sessionDir: false });
      await mkdir(join(stateDir, "sessions", sessionId), { recursive: true });

      const result = await dispatchCodexNativeHook({
        hook_event_name: "Stop",
        cwd,
        session_id: sessionId,
        transcript_path: `rollout-${sessionId}.jsonl`,
      }, { cwd });

      assert.equal(result.outputJson, null);
      assert.equal(await readFile(join(stateDir, "session.json"), "utf-8"), pointerBefore);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("fails closed for conflicting session_id/sessionId aliases", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omx-3427-conflicting-aliases-"));
    try {
      const sessionId = "alias-conflict-session-3427";
      const { stateDir, transcriptPath, pointerBefore } = await writeStaleDeadStopFixture(cwd, sessionId);

      const result = await dispatchCodexNativeHook({
        hook_event_name: "Stop",
        cwd,
        session_id: sessionId,
        sessionId: "other-alias-session-3427",
        transcript_path: transcriptPath,
      }, { cwd });

      assert.equal(result.outputJson, null);
      assert.equal(await readFile(join(stateDir, "session.json"), "utf-8"), pointerBefore);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("fails closed for non-string transcript aliases", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omx-3427-nonstring-transcript-"));
    try {
      const sessionId = "nonstring-transcript-session-3427";
      const { stateDir, transcriptPath, pointerBefore } = await writeStaleDeadStopFixture(cwd, sessionId);

      const result = await dispatchCodexNativeHook({
        hook_event_name: "Stop",
        cwd,
        session_id: sessionId,
        transcript_path: 42,
        transcriptPath,
      }, { cwd });

      assert.equal(result.outputJson, null);
      assert.equal(await readFile(join(stateDir, "session.json"), "utf-8"), pointerBefore);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("fails closed when transcript_path and transcriptPath disagree", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omx-3427-transcript-alias-conflict-"));
    try {
      const sessionId = "transcript-alias-session-3427";
      const { stateDir, transcriptPath, pointerBefore } = await writeStaleDeadStopFixture(cwd, sessionId);
      const otherPath = join(cwd, `rollout-${sessionId}-other.jsonl`);
      await writeFile(otherPath, `${JSON.stringify({
        type: "session_meta",
        payload: { id: sessionId, session_id: sessionId, cwd },
      })}\n`);

      const result = await dispatchCodexNativeHook({
        hook_event_name: "Stop",
        cwd,
        session_id: sessionId,
        transcript_path: transcriptPath,
        transcriptPath: otherPath,
      }, { cwd });

      assert.equal(result.outputJson, null);
      assert.equal(await readFile(join(stateDir, "session.json"), "utf-8"), pointerBefore);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("fails closed for owner identity claims", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omx-3427-owner-claim-"));
    try {
      const sessionId = "owner-claim-session-3427";
      const { stateDir, transcriptPath, pointerBefore } = await writeStaleDeadStopFixture(cwd, sessionId);

      const result = await dispatchCodexNativeHook({
        hook_event_name: "Stop",
        cwd,
        session_id: sessionId,
        transcript_path: transcriptPath,
        owner_codex_session_id: sessionId,
      }, { cwd });

      assert.equal(result.outputJson, null);
      assert.equal(await readFile(join(stateDir, "session.json"), "utf-8"), pointerBefore);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("fails closed for subagent thread-spawn provenance", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omx-3427-subagent-provenance-"));
    try {
      const sessionId = "subagent-provenance-session-3427";
      const { stateDir, transcriptPath, pointerBefore } = await writeStaleDeadStopFixture(cwd, sessionId);

      const result = await dispatchCodexNativeHook({
        hook_event_name: "Stop",
        cwd,
        session_id: sessionId,
        transcript_path: transcriptPath,
        source: { subagent: { thread_spawn: { parent_thread_id: "some-parent", depth: 1 } } },
      }, { cwd });

      assert.equal(result.outputJson, null);
      assert.equal(await readFile(join(stateDir, "session.json"), "utf-8"), pointerBefore);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
  it("fails closed for a payload with agent_id subagent provenance", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omx-3427-agent-id-provenance-"));
    try {
      const sessionId = "agent-id-provenance-session-3427";
      const { stateDir, transcriptPath, pointerBefore } = await writeStaleDeadStopFixture(cwd, sessionId);

      const result = await dispatchCodexNativeHook({
        hook_event_name: "Stop",
        cwd,
        session_id: sessionId,
        transcript_path: transcriptPath,
        agent_id: "child-agent-thread",
      }, { cwd });

      assert.equal(result.outputJson, null);
      assert.equal(await readFile(join(stateDir, "session.json"), "utf-8"), pointerBefore);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("fails closed for a typed agent-role subagent payload", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omx-3427-agent-role-provenance-"));
    try {
      const sessionId = "agent-role-provenance-session-3427";
      const { stateDir, transcriptPath, pointerBefore } = await writeStaleDeadStopFixture(cwd, sessionId);

      const result = await dispatchCodexNativeHook({
        hook_event_name: "Stop",
        cwd,
        session_id: sessionId,
        transcript_path: transcriptPath,
        agent_type: "executor",
      }, { cwd });

      assert.equal(result.outputJson, null);
      assert.equal(await readFile(join(stateDir, "session.json"), "utf-8"), pointerBefore);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("fails closed when the session-scoped state directory is missing", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omx-3427-missing-session-dir-"));
    try {
      const sessionId = "missing-session-dir-3427";
      const { stateDir, transcriptPath, pointerBefore } = await writeStaleDeadStopFixture(cwd, sessionId, { sessionDir: false });

      const result = await dispatchCodexNativeHook({
        hook_event_name: "Stop",
        cwd,
        session_id: sessionId,
        transcript_path: transcriptPath,
      }, { cwd });

      assert.equal(result.outputJson, null);
      assert.equal(await readFile(join(stateDir, "session.json"), "utf-8"), pointerBefore);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("fails closed for a symlink transcript", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omx-3427-symlink-transcript-"));
    try {
      const sessionId = "symlink-transcript-session-3427";
      const { stateDir, pointerBefore } = await writeStaleDeadStopFixture(cwd, sessionId, { transcript: false });
      const realTranscript = join(cwd, `real-${sessionId}.jsonl`);
      await writeFile(realTranscript, `${JSON.stringify({
        type: "session_meta",
        payload: { id: sessionId, session_id: sessionId, cwd },
      })}\n`);
      const transcriptPath = join(cwd, `rollout-${sessionId}.jsonl`);
      await symlink(realTranscript, transcriptPath);

      const result = await dispatchCodexNativeHook({
        hook_event_name: "Stop",
        cwd,
        session_id: sessionId,
        transcript_path: transcriptPath,
      }, { cwd });

      assert.equal(result.outputJson, null);
      assert.equal(await readFile(join(stateDir, "session.json"), "utf-8"), pointerBefore);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("fails closed when the transcript first record is not session_meta", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omx-3427-non-meta-transcript-"));
    try {
      const sessionId = "non-meta-transcript-session-3427";
      const { stateDir, pointerBefore } = await writeStaleDeadStopFixture(cwd, sessionId, { transcript: false });
      const transcriptPath = join(cwd, `rollout-${sessionId}.jsonl`);
      await writeFile(
        transcriptPath,
        `${JSON.stringify({ type: "event_msg", payload: { type: "user_message", message: "hi" } })}\n`,
      );

      const result = await dispatchCodexNativeHook({
        hook_event_name: "Stop",
        cwd,
        session_id: sessionId,
        transcript_path: transcriptPath,
      }, { cwd });

      assert.equal(result.outputJson, null);
      assert.equal(await readFile(join(stateDir, "session.json"), "utf-8"), pointerBefore);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("fails closed for an identity-indeterminate pointer even with a valid transcript", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omx-3427-indeterminate-pointer-"));
    try {
      const sessionId = "indeterminate-session-3427";
      const { stateDir, transcriptPath, pointerBefore } = await writeStaleDeadStopFixture(cwd, sessionId, {
        pointer: { identity_schema_version: 1 },
      });

      const result = await dispatchCodexNativeHook({
        hook_event_name: "Stop",
        cwd,
        session_id: sessionId,
        transcript_path: transcriptPath,
      }, { cwd });

      assert.equal(result.outputJson, null);
      assert.equal(await readFile(join(stateDir, "session.json"), "utf-8"), pointerBefore);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("never rewrites the singleton selected pointer during transcript recovery", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omx-3427-pointer-immutable-"));
    try {
      const sessionId = "pointer-immutable-session-3427";
      const { stateDir, transcriptPath, pointerBefore } = await writeStaleDeadStopFixture(cwd, sessionId);
      await writeSessionScopedModeState(cwd, sessionId, "autopilot");

      const result = await dispatchCodexNativeHook({
        hook_event_name: "Stop",
        cwd,
        session_id: sessionId,
        transcript_path: transcriptPath,
      }, { cwd });

      assert.equal(result.outputJson?.decision, "block");
      assert.equal(await readFile(join(stateDir, "session.json"), "utf-8"), pointerBefore);
      assert.equal(existsSync(join(stateDir, "sessions", "stale-dead", "session.json")), false);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("covers the built distribution entrypoint for the transcript-backed recovery", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omx-3427-dist-recovery-"));
    try {
      const sessionId = "dist-recovery-session-3427";
      const { stateDir, transcriptPath, pointerBefore } = await writeStaleDeadStopFixture(cwd, sessionId);
      await writeSessionScopedModeState(cwd, sessionId, "autopilot");

      const output = parseSingleJsonStdout(runNativeHookCli({
        hook_event_name: "Stop",
        cwd,
        session_id: sessionId,
        transcript_path: transcriptPath,
      }, { cwd }));

      assert.equal(output.decision, "block");
      assert.equal(output.stopReason, "autopilot_executing");
      assert.equal(await readFile(join(stateDir, "session.json"), "utf-8"), pointerBefore);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("fails closed in the built distribution entrypoint for a conflicting alias", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omx-3427-dist-failclosed-"));
    try {
      const sessionId = "dist-failclosed-session-3427";
      const { stateDir, transcriptPath, pointerBefore } = await writeStaleDeadStopFixture(cwd, sessionId);

      const output = parseSingleJsonStdout(runNativeHookCli({
        hook_event_name: "Stop",
        cwd,
        session_id: sessionId,
        sessionId: "dist-other-session-3427",
        transcript_path: transcriptPath,
      }, { cwd }));

      assert.deepEqual(output, {});
      assert.equal(await readFile(join(stateDir, "session.json"), "utf-8"), pointerBefore);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
