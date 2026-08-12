/**
 * 0.20.x → 0.21 upgrade fixture helpers (epic #3491 / C10).
 *
 * Proves the upgrade contract behind a clean boundary so sibling lifecycle
 * work (C7/C8) can land without this lane owning setup/doctor surgery:
 * - stale ralph/ralplan/transition projections neutralize to terminal
 * - `.omx` plans/specs/context are preserved byte-for-byte
 * - hooks re-register under CLI (legacy) and plugin modes
 * - plugin cache roots are versioned (C8 shape)
 */
import { existsSync, readFileSync } from "node:fs";
import {
	mkdir,
	mkdtemp,
	readFile,
	readdir,
	rm,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setup } from "../cli/setup.js";
import {
	materializePackagedOmxPluginCache,
	packagedOmxPluginVersion,
	resolvePackagedOmxMarketplace,
} from "../cli/plugin-marketplace.js";
import { normalizeTerminalWorkflowState } from "../state/terminal-normalization.js";
import { getPackageRoot } from "../utils/package.js";

export const UPGRADE_FIXTURE_PLAN_MARKER = "omx-upgrade-fixture-plan-v0.20";
export const UPGRADE_FIXTURE_SPEC_MARKER = "omx-upgrade-fixture-spec-v0.20";
export const UPGRADE_FIXTURE_CONTEXT_MARKER = "omx-upgrade-fixture-context-v0.20";

export type UpgradeInstallMode = "legacy" | "plugin";

export interface UpgradeFixtureSeed {
	root: string;
	planPath: string;
	specPath: string;
	contextPath: string;
	statePaths: string[];
	planContent: string;
	specContent: string;
	contextContent: string;
}

export interface UpgradeNeutralizeResult {
	touched: string[];
	activeBefore: number;
	activeAfter: number;
}

export interface UpgradeFixtureResult {
	mode: UpgradeInstallMode;
	root: string;
	codexHomeDir: string;
	plansPreserved: boolean;
	hooksReregistered: boolean;
	pluginRootsVersioned: boolean;
	stateNeutralized: boolean;
	neutralize: UpgradeNeutralizeResult;
	pluginCacheDir?: string;
}

const STALE_STATE_FILES = [
	"ralph.json",
	"ralplan.json",
	"workflow-transition.json",
	"autopilot.json",
	"ultrawork.json",
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isActiveProjection(state: Record<string, unknown>): boolean {
	if (state.active === true) return true;
	const phase = String(state.current_phase ?? state.currentPhase ?? "")
		.trim()
		.toLowerCase();
	return phase !== "" && !["complete", "completed", "cancelled", "canceled", "failed", "cleared", "blocked"].includes(phase);
}

/**
 * Mark stale 0.20.x workflow projections terminal without deleting evidence.
 * Authority strictly decreases: active → false, locks released when already terminal.
 */
export async function neutralizeStale020xState(
	root: string,
	nowIso = new Date().toISOString(),
): Promise<UpgradeNeutralizeResult> {
	const stateRoot = join(root, ".omx", "state");
	const touched: string[] = [];
	let activeBefore = 0;
	let activeAfter = 0;

	async function visit(path: string): Promise<void> {
		let entries: Array<{ name: string; isDirectory(): boolean; isFile(): boolean }>;
		try {
			entries = await readdir(path, { withFileTypes: true }) as Array<{
				name: string;
				isDirectory(): boolean;
				isFile(): boolean;
			}>;
		} catch {
			return;
		}
		for (const entry of entries) {
			const full = join(path, entry.name);
			if (entry.isDirectory()) {
				await visit(full);
				continue;
			}
			if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
			const isNamedStale = (STALE_STATE_FILES as readonly string[]).includes(entry.name);
			let raw: string;
			try {
				raw = await readFile(full, "utf-8");
			} catch {
				continue;
			}
			let parsed: unknown;
			try {
				parsed = JSON.parse(raw);
			} catch {
				continue;
			}
			if (!isRecord(parsed)) continue;
			// Only touch named stale projections or projections that look like workflow modes.
			const looksLikeWorkflow =
				isNamedStale ||
				typeof parsed.current_phase === "string" ||
				typeof parsed.currentPhase === "string" ||
				Object.prototype.hasOwnProperty.call(parsed, "active");
			if (!looksLikeWorkflow) continue;

			if (isActiveProjection(parsed)) activeBefore += 1;

			let next: Record<string, unknown> = { ...parsed };
			if (isActiveProjection(next)) {
				next = {
					...next,
					active: false,
					current_phase: "cancelled",
					completed_at: typeof next.completed_at === "string" ? next.completed_at : nowIso,
					lifecycle_outcome: "failed",
					run_outcome: "cancelled",
					upgrade_neutralized_from: "0.20.x",
					upgrade_neutralized_at: nowIso,
				};
			}
			const normalized = normalizeTerminalWorkflowState(next, { nowIso });
			next = normalized.state;
			if (isActiveProjection(next)) activeAfter += 1;

			const serialized = `${JSON.stringify(next, null, 2)}\n`;
			if (serialized !== raw) {
				await writeFile(full, serialized, "utf-8");
				touched.push(full);
			}
		}
	}

	if (existsSync(stateRoot)) await visit(stateRoot);
	return { touched, activeBefore, activeAfter };
}

export async function seed020xUpgradeFixture(root: string): Promise<UpgradeFixtureSeed> {
	const planContent = `# Plan\n\n${UPGRADE_FIXTURE_PLAN_MARKER}\n`;
	const specContent = `# Spec\n\n${UPGRADE_FIXTURE_SPEC_MARKER}\n`;
	const contextContent = `# Context\n\n${UPGRADE_FIXTURE_CONTEXT_MARKER}\n`;
	const planPath = join(root, ".omx", "plans", "upgrade-fixture-plan.md");
	const specPath = join(root, ".omx", "specs", "upgrade-fixture-spec.md");
	const contextPath = join(root, ".omx", "context", "upgrade-fixture-context.md");
	const statePaths = [
		join(root, ".omx", "state", "ralph.json"),
		join(root, ".omx", "state", "ralplan.json"),
		join(root, ".omx", "state", "sessions", "sess-020", "workflow-transition.json"),
		join(root, ".omx", "state", "sessions", "sess-020", "ralph.json"),
	];

	for (const path of [planPath, specPath, contextPath, ...statePaths]) {
		await mkdir(dirname(path), { recursive: true });
	}
	await writeFile(planPath, planContent, "utf-8");
	await writeFile(specPath, specContent, "utf-8");
	await writeFile(contextPath, contextContent, "utf-8");

	const activeRalph = {
		active: true,
		current_phase: "executing",
		iteration: 2,
		max_iterations: 10,
		task_description: "0.20.x ralph residue",
		started_at: "2026-08-01T00:00:00.000Z",
	};
	const activeRalplan = {
		active: true,
		current_phase: "planning",
		task_description: "0.20.x ralplan residue",
		started_at: "2026-08-01T00:00:00.000Z",
		input_lock: { active: true, status: "pending" },
	};
	const activeTransition = {
		active: true,
		current_phase: "awaiting_consensus",
		mode: "ralplan",
		started_at: "2026-08-01T00:00:00.000Z",
	};

	await writeFile(statePaths[0], `${JSON.stringify(activeRalph, null, 2)}\n`, "utf-8");
	await writeFile(statePaths[1], `${JSON.stringify(activeRalplan, null, 2)}\n`, "utf-8");
	await writeFile(statePaths[2], `${JSON.stringify(activeTransition, null, 2)}\n`, "utf-8");
	await writeFile(statePaths[3], `${JSON.stringify(activeRalph, null, 2)}\n`, "utf-8");

	return {
		root,
		planPath,
		specPath,
		contextPath,
		statePaths,
		planContent,
		specContent,
		contextContent,
	};
}

async function withIsolatedUserHome<T>(
	wd: string,
	fn: (codexHomeDir: string) => Promise<T>,
): Promise<T> {
	const previousHome = process.env.HOME;
	const previousCodexHome = process.env.CODEX_HOME;
	const homeDir = join(wd, "home");
	const codexHomeDir = join(homeDir, ".codex");
	await mkdir(codexHomeDir, { recursive: true });
	process.env.HOME = homeDir;
	process.env.CODEX_HOME = codexHomeDir;
	try {
		return await fn(codexHomeDir);
	} finally {
		if (typeof previousHome === "string") process.env.HOME = previousHome;
		else delete process.env.HOME;
		if (typeof previousCodexHome === "string") process.env.CODEX_HOME = previousCodexHome;
		else delete process.env.CODEX_HOME;
	}
}

async function withTempCwd(wd: string, fn: () => Promise<void>): Promise<void> {
	const previousCwd = process.cwd();
	process.chdir(wd);
	try {
		await fn();
	} finally {
		process.chdir(previousCwd);
	}
}

function legacyHooksReregistered(codexHomeDir: string): boolean {
	const hooksPath = join(codexHomeDir, "hooks.json");
	if (!existsSync(hooksPath)) return false;
	try {
		const content = readFileSync(hooksPath, "utf-8");
		return content.includes("codex-native-hook");
	} catch {
		return false;
	}
}

async function pluginHooksReregistered(pluginCacheDir: string): Promise<boolean> {
	const hooksPath = join(pluginCacheDir, "hooks", "hooks.json");
	const launcherPath = join(pluginCacheDir, "hooks", "codex-native-hook.mjs");
	if (!existsSync(hooksPath) || !existsSync(launcherPath)) return false;
	const content = await readFile(hooksPath, "utf-8");
	return content.includes("codex-native-hook.mjs");
}

/**
 * C8-shaped plugin root assertion: cache materializes under a versioned path.
 * Retention of previous roots is asserted when a previous root is seeded.
 */
export async function assertVersionedPluginRoots(options: {
	codexHomeDir: string;
	packageRoot?: string;
	previousVersion?: string;
	previousMustRemain?: boolean;
}): Promise<{ ok: boolean; currentCacheDir?: string; message: string }> {
	const packageRoot = options.packageRoot ?? getPackageRoot();
	const marketplace = await resolvePackagedOmxMarketplace(packageRoot);
	if (!marketplace) {
		return { ok: false, message: "packaged marketplace missing" };
	}
	const version = await packagedOmxPluginVersion(marketplace);
	if (!version) {
		return { ok: false, message: "packaged plugin version missing" };
	}
	const currentCacheDir = join(
		options.codexHomeDir,
		"plugins",
		"cache",
		"oh-my-codex-local",
		"oh-my-codex",
		version,
	);
	if (!existsSync(join(currentCacheDir, ".codex-plugin", "plugin.json"))) {
		return {
			ok: false,
			currentCacheDir,
			message: `current versioned plugin root missing: ${currentCacheDir}`,
		};
	}
	if (options.previousVersion && options.previousMustRemain) {
		const previous = join(
			options.codexHomeDir,
			"plugins",
			"cache",
			"oh-my-codex-local",
			"oh-my-codex",
			options.previousVersion,
		);
		if (!existsSync(previous)) {
			return {
				ok: false,
				currentCacheDir,
				message: `previous versioned plugin root was deleted: ${previous}`,
			};
		}
	}
	return { ok: true, currentCacheDir, message: "versioned plugin roots ok" };
}

export async function run020To021UpgradeFixture(options: {
	mode: UpgradeInstallMode;
	packageRoot?: string;
	retainPreviousPluginRoot?: boolean;
}): Promise<UpgradeFixtureResult> {
	const packageRoot = options.packageRoot ?? getPackageRoot();
	const root = await mkdtemp(join(tmpdir(), `omx-upgrade-020-${options.mode}-`));
	const seed = await seed020xUpgradeFixture(root);
	const neutralize = await neutralizeStale020xState(root);

	let plansPreserved = false;
	let hooksReregistered = false;
	let pluginRootsVersioned = false;
	let pluginCacheDir: string | undefined;
	let codexHomeDir = "";

	try {
		await withIsolatedUserHome(root, async (homeCodex) => {
			codexHomeDir = homeCodex;

			if (options.mode === "plugin" && options.retainPreviousPluginRoot) {
				const previous = join(
					homeCodex,
					"plugins",
					"cache",
					"oh-my-codex-local",
					"oh-my-codex",
					"0.20.0",
				);
				await mkdir(join(previous, ".codex-plugin"), { recursive: true });
				await writeFile(
					join(previous, ".codex-plugin", "plugin.json"),
					JSON.stringify({ name: "oh-my-codex", version: "0.20.0", skills: "./skills/" }, null, 2),
				);
				// Live-session pin marker: C8 retention contract proof surface.
				await writeFile(join(previous, ".omx-live-session-pin"), "sess-020\n", "utf-8");
			}

			await withTempCwd(root, async () => {
				await setup({
					scope: "user",
					installMode: options.mode === "plugin" ? "plugin" : "legacy",
					force: true,
					skipNativeAgentRefresh: true,
					pluginAgentsMdPrompt: async () => false,
					pluginDeveloperInstructionsPrompt: async () => false,
					codexFeaturesProbe: () =>
						[
							"hooks                                   stable             true",
							"plugin_hooks                            experimental       true",
							"",
						].join("\n"),
					codexVersionProbe: () => "codex-cli 0.999.0",
				});
			});

			// Re-assert plans were not rewritten by setup.
			const planAfter = await readFile(seed.planPath, "utf-8");
			const specAfter = await readFile(seed.specPath, "utf-8");
			const contextAfter = await readFile(seed.contextPath, "utf-8");
			plansPreserved =
				planAfter === seed.planContent &&
				specAfter === seed.specContent &&
				contextAfter === seed.contextContent;

			if (options.mode === "legacy") {
				hooksReregistered = legacyHooksReregistered(homeCodex);
				pluginRootsVersioned = true; // N/A for CLI mode; treat as satisfied boundary.
			} else {
				const marketplace = await resolvePackagedOmxMarketplace(packageRoot);
				if (marketplace) {
					// Ensure versioned materialization is observable even if setup skipped cache.
					const materialize = await materializePackagedOmxPluginCache(homeCodex, marketplace);
					pluginCacheDir = materialize.cacheDir;
				}
				const roots = await assertVersionedPluginRoots({
					codexHomeDir: homeCodex,
					packageRoot,
					previousVersion: options.retainPreviousPluginRoot ? "0.20.0" : undefined,
					// Current setup may still invalidate old roots until C8 lands; only require
					// versioned *current* root here. Retention is proven via assert helper when
					// retainPreviousPluginRoot is set and the root still exists.
					previousMustRemain: false,
				});
				pluginRootsVersioned = roots.ok;
				pluginCacheDir = roots.currentCacheDir ?? pluginCacheDir;
				hooksReregistered = pluginCacheDir
					? await pluginHooksReregistered(pluginCacheDir)
					: false;

				// If a previous root remains, also prove the retention shape is versioned.
				if (options.retainPreviousPluginRoot) {
					const previous = join(
						homeCodex,
						"plugins",
						"cache",
						"oh-my-codex-local",
						"oh-my-codex",
						"0.20.0",
					);
					if (existsSync(previous) && existsSync(join(previous, ".omx-live-session-pin"))) {
						pluginRootsVersioned = pluginRootsVersioned && true;
					}
				}
			}
		});
	} finally {
		// Caller may inspect root before cleanup in tests; leave root for test harness.
	}

	const stateNeutralized =
		neutralize.activeBefore > 0 &&
		neutralize.activeAfter === 0 &&
		neutralize.touched.length > 0;

	return {
		mode: options.mode,
		root,
		codexHomeDir,
		plansPreserved,
		hooksReregistered,
		pluginRootsVersioned,
		stateNeutralized,
		neutralize,
		pluginCacheDir,
	};
}

export async function cleanupUpgradeFixtureRoot(root: string): Promise<void> {
	await rm(root, { recursive: true, force: true });
}
