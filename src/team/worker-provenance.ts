/**
 * Shared authoritative Team-worker provenance verification and Conductor
 * policy-root resolution (#3536).
 *
 * The native hook and `omx doctor --team` must evaluate the exact same
 * worker-verification and policy-root preflight so a verified Team worker
 * cannot be runtime-denied while doctor reports all-pass. Verification is
 * evidence-returning (never a bare boolean plus later env re-read): policy
 * context may only be derived from the structured result produced here.
 */
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { canonicalizeComparablePath, sameFilePath } from "../utils/paths.js";
import { resolveWorkerTeamStateRootPath } from "./state-root.js";

function safeString(value: unknown): string {
  return typeof value === "string" ? value : value == null ? "" : String(value);
}

function safeObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

async function readJsonIfExists(path: string): Promise<Record<string, unknown> | null> {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(await readFile(path, "utf-8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function readJsonSyncIfExists(path: string): Record<string, unknown> | null {
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export interface TeamWorkerEnvIdentity {
  teamName: string;
  workerName: string;
}

function parseTeamWorkerEnv(rawValue: string): TeamWorkerEnvIdentity | null {
  const match = /^([a-z0-9][a-z0-9-]{0,29})\/(worker-\d+)$/.exec(rawValue.trim());
  if (!match) return null;
  return {
    teamName: match[1] || "",
    workerName: match[2] || "",
  };
}

export function readTeamWorkerEnvironment(env: NodeJS.ProcessEnv = process.env): TeamWorkerEnvIdentity | null {
  const internalWorker = parseTeamWorkerEnv(safeString(env.OMX_TEAM_INTERNAL_WORKER));
  const externalWorker = parseTeamWorkerEnv(safeString(env.OMX_TEAM_WORKER));
  if (!internalWorker) return null;
  if (externalWorker && internalWorker.workerName !== externalWorker.workerName) return null;
  // The public Team name is a display alias; only the session-scoped internal
  // identity is authoritative for state-root/config/manifest validation.
  return internalWorker;
}

export function readCanonicalInternalTeamWorkerEnvironment(env: NodeJS.ProcessEnv = process.env): TeamWorkerEnvIdentity | null {
  const rawInternalWorker = safeString(env.OMX_TEAM_INTERNAL_WORKER).trim();
  if (!rawInternalWorker) return null;
  const internalWorker = parseTeamWorkerEnv(rawInternalWorker);
  if (!internalWorker) return null;
  const rawExternalWorker = safeString(env.OMX_TEAM_WORKER).trim();
  if (!rawExternalWorker) return internalWorker;
  const externalWorker = parseTeamWorkerEnv(rawExternalWorker);
  if (!externalWorker || externalWorker.workerName !== internalWorker.workerName) return null;
  return internalWorker;
}

/**
 * Structured result of a fully verified authoritative Team-worker context.
 * Every field is canonicalized and cross-checked against the worker identity,
 * config, manifest, pane, worktree, state-root, and leader-CWD metadata; an
 * external Team state root may contribute policy context only through this
 * evidence, never through unverified environment values.
 */
export interface AuthoritativeTeamWorkerEvidence {
  teamName: string;
  workerName: string;
  stateRoot: string;
  canonicalStateRoot: string;
  canonicalLeaderCwd: string;
  canonicalWorkerCwd: string;
}

export async function resolveAuthoritativeTeamWorkerContext(
  cwd: string,
  options: { requireWorkerPane?: boolean; env?: NodeJS.ProcessEnv } = {},
): Promise<AuthoritativeTeamWorkerEvidence | null> {
  const env = options.env ?? process.env;
  const workerContext = readCanonicalInternalTeamWorkerEnvironment(env);
  if (!workerContext) return null;

  const requireWorkerPane = options.requireWorkerPane === true;
  const currentPaneId = safeString(env.TMUX_PANE).trim();
  if (requireWorkerPane && !currentPaneId) return null;
  const stateRoot = await resolveWorkerTeamStateRootPath(cwd, workerContext, env).catch(() => null);
  if (!stateRoot) return null;

  const teamRoot = join(stateRoot, "team", workerContext.teamName);
  const identity = await readJsonIfExists(join(teamRoot, "workers", workerContext.workerName, "identity.json"));
  const manifest = await readJsonIfExists(join(teamRoot, "manifest.v2.json"));
  const config = await readJsonIfExists(join(teamRoot, "config.json"));
  if (!identity || !manifest || !config) return null;

  const canonicalStateRoot = canonicalizeComparablePath(stateRoot);
  const canonicalCwd = canonicalizeComparablePath(cwd);
  const canonicalLeaderCwd = canonicalizeComparablePath(safeString(env.OMX_TEAM_LEADER_CWD).trim() || cwd);
  const pathMatches = (value: unknown, expected: string): boolean => {
    const candidate = safeString(value).trim();
    if (!candidate) return false;
    try {
      return sameFilePath(candidate, expected);
    } catch {
      return false;
    }
  };
  const matchingWorker = (state: Record<string, unknown>): Record<string, unknown> | null => {
    const workers = Array.isArray(state.workers) ? state.workers : [];
    return workers
      .map((candidate) => safeObject(candidate))
      .find((candidate) => safeString(candidate.name).trim() === workerContext.workerName) ?? null;
  };
  const manifestWorker = matchingWorker(manifest);
  const configWorker = matchingWorker(config);
  if (!manifestWorker || !configWorker) return null;
  if (safeString(identity.name).trim() !== workerContext.workerName) return null;
  if (requireWorkerPane && safeString(identity.pane_id).trim() !== currentPaneId) return null;
  if (!pathMatches(identity.team_state_root, canonicalStateRoot)) return null;
  if (!pathMatches(identity.worktree_path ?? identity.working_dir, canonicalCwd)) return null;
  for (const state of [manifest, config]) {
    if (safeString(state.name).trim() !== workerContext.teamName) return null;
    if (requireWorkerPane && safeString(state.leader_pane_id).trim() === currentPaneId) return null;
    if (!pathMatches(state.team_state_root, canonicalStateRoot)) return null;
    if (!pathMatches(state.leader_cwd, canonicalLeaderCwd)) return null;
  }
  if (safeString(manifest.leader_pane_id).trim() !== safeString(config.leader_pane_id).trim()) return null;
  for (const worker of [manifestWorker, configWorker]) {
    if (requireWorkerPane && safeString(worker.pane_id).trim() !== currentPaneId) return null;
    if (!pathMatches(worker.team_state_root, canonicalStateRoot)) return null;
    const workingDir = safeString(worker.working_dir).trim();
    const worktreePath = safeString(worker.worktree_path).trim();
    if (!workingDir && !worktreePath) return null;
    if (workingDir && !pathMatches(workingDir, canonicalCwd)) return null;
    if (worktreePath && !pathMatches(worktreePath, canonicalCwd)) return null;
  }
  return {
    teamName: workerContext.teamName,
    workerName: workerContext.workerName,
    stateRoot,
    canonicalStateRoot,
    canonicalLeaderCwd,
    canonicalWorkerCwd: canonicalCwd,
  };
}

export interface ConductorPolicyRootResolution {
  cwd: string;
  valid: boolean;
  statePresent: boolean;
  externalStateRoot: boolean;
  /** True when validity was established by verified Team-worker evidence. */
  teamWorkerBound: boolean;
}

export function resolveConductorPolicyRoot(
  stateDir: string,
  fallbackCwd: string,
  teamWorker: AuthoritativeTeamWorkerEvidence | null = null,
): ConductorPolicyRootResolution {
  const statePresent = existsSync(join(stateDir, "session.json"))
    || existsSync(join(stateDir, "sessions"));
  let canonicalFallback: string;
  try {
    canonicalFallback = realpathSync(resolve(fallbackCwd));
  } catch {
    canonicalFallback = resolve(fallbackCwd);
  }
  let canonicalStateDir: string | null = null;
  try {
    canonicalStateDir = realpathSync(stateDir);
    const rootSession = readJsonSyncIfExists(join(canonicalStateDir, "session.json"));
    const recordedCwd = safeString(rootSession?.cwd ?? rootSession?.workingDirectory).trim();
    if (recordedCwd) {
      const canonicalRecordedCwd = realpathSync(resolve(recordedCwd));
      return {
        cwd: canonicalRecordedCwd,
        valid: true,
        statePresent,
        externalStateRoot: canonicalStateDir !== join(canonicalRecordedCwd, ".omx", "state"),
        teamWorkerBound: false,
      };
    }
    if (canonicalStateDir === join(canonicalFallback, ".omx", "state")) {
      return { cwd: canonicalFallback, valid: true, statePresent, externalStateRoot: false, teamWorkerBound: false };
    }
  } catch {
    // An external state surface with an unusable pointer must not borrow execution-cwd authority.
  }
  // #3536: only after full authoritative Team-worker verification may an
  // external Team state root contribute policy context. The verified root must
  // canonically match the currently selected stateDir, and the policy CWD is
  // the already-verified canonical Team leader CWD from the evidence. Every
  // unverified or mismatched root keeps failing closed below.
  if (teamWorker) {
    const selectedStateDir = canonicalStateDir ?? canonicalizeComparablePath(stateDir);
    if (sameFilePath(teamWorker.canonicalStateRoot, selectedStateDir)) {
      return {
        cwd: teamWorker.canonicalLeaderCwd,
        valid: true,
        statePresent,
        externalStateRoot: true,
        teamWorkerBound: true,
      };
    }
  }
  return { cwd: canonicalFallback, valid: !statePresent, statePresent, externalStateRoot: statePresent, teamWorkerBound: false };
}
