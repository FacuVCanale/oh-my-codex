import { existsSync } from "fs";
import { cp, lstat, mkdir, mkdtemp, readdir, readFile, realpath, rename, rm, writeFile } from "fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "path";
import { tmpdir } from "node:os";
import { OMX_FIRST_PARTY_MCP_SERVER_NAMES } from "../config/omx-first-party-mcp.js";
import { teamModeEnabled, type SetupTeamMode } from "../config/team-mode.js";

export const OMX_LOCAL_MARKETPLACE_NAME = "oh-my-codex-local";
export const OMX_PLUGIN_NAME = "oh-my-codex";
export const OMX_LOCAL_PLUGIN_CONFIG_KEY = `${OMX_PLUGIN_NAME}@${OMX_LOCAL_MARKETPLACE_NAME}`;

export interface PackagedOmxMarketplace {
	marketplacePath: string;
	packageRoot: string;
	pluginRoot: string;
	pluginManifestPath: string;
}

interface MarketplaceManifest {
	name?: unknown;
	plugins?: Array<{
		name?: unknown;
		source?: { source?: unknown; path?: unknown };
	}>;
}

interface PluginManifest {
	name?: unknown;
	version?: unknown;
	skills?: unknown;
	hooks?: unknown;
	mcpServers?: unknown;
	apps?: unknown;
}

const OMX_PLUGIN_HOOK_LAUNCHER_FILE = "omx-command.json";
const TEAM_MODE_PLUGIN_SKILL_NAMES = new Set(["team", "worker"]);

export async function resolvePackagedOmxMarketplace(
	packageRoot: string,
): Promise<PackagedOmxMarketplace | null> {
	const marketplacePath = join(
		packageRoot,
		".agents",
		"plugins",
		"marketplace.json",
	);
	if (!existsSync(marketplacePath)) return null;

	let marketplace: MarketplaceManifest;
	try {
		marketplace = JSON.parse(
			await readFile(marketplacePath, "utf-8"),
		) as MarketplaceManifest;
	} catch {
		return null;
	}

	if (marketplace.name !== OMX_LOCAL_MARKETPLACE_NAME) return null;
	const pluginEntry = marketplace.plugins?.find(
		(entry) =>
			entry.name === OMX_PLUGIN_NAME &&
			entry.source?.source === "local" &&
			typeof entry.source.path === "string",
	);
	if (!pluginEntry || typeof pluginEntry.source?.path !== "string") return null;

	const pluginRoot = resolve(packageRoot, pluginEntry.source.path);
	const pluginManifestPath = join(pluginRoot, ".codex-plugin", "plugin.json");
	if (!existsSync(pluginManifestPath)) return null;

	try {
		const pluginManifest = JSON.parse(
			await readFile(pluginManifestPath, "utf-8"),
		) as PluginManifest;
		if (
			pluginManifest.name !== OMX_PLUGIN_NAME ||
			pluginManifest.skills !== "./skills/"
		) {
			return null;
		}
	} catch {
		return null;
	}

	return { marketplacePath, packageRoot, pluginRoot, pluginManifestPath };
}

async function readPluginManifest(
	manifestPath: string,
): Promise<PluginManifest | null> {
	try {
		return JSON.parse(await readFile(manifestPath, "utf-8")) as PluginManifest;
	} catch {
		return null;
	}
}

async function listChildDirectoryNames(dir: string): Promise<string[] | null> {
	try {
		const entries = await readdir(dir, { withFileTypes: true });
		return entries
			.filter((entry) => entry.isDirectory())
			.map((entry) => entry.name)
			.sort();
	} catch {
		return null;
	}
}

async function listRegularChildDirectoryNames(dir: string): Promise<string[] | null> {
	try {
		const stats = await lstat(dir);
		if (!stats.isDirectory() || stats.isSymbolicLink()) return null;
		const entries = await readdir(dir, { withFileTypes: true });
		if (entries.some((entry) => entry.isSymbolicLink())) return null;
		return entries
			.filter((entry) => entry.isDirectory())
			.map((entry) => entry.name)
			.sort();
	} catch {
		return null;
	}
}

async function readRegularOmxPluginCacheManifest(
	cacheDir: string,
): Promise<PluginManifest | null> {
	const manifestDir = join(cacheDir, ".codex-plugin");
	const manifestPath = join(manifestDir, "plugin.json");
	try {
		const manifestDirStats = await lstat(manifestDir);
		if (!manifestDirStats.isDirectory() || manifestDirStats.isSymbolicLink()) return null;
		const manifestStats = await lstat(manifestPath);
		if (!manifestStats.isFile() || manifestStats.isSymbolicLink()) return null;
		return await readPluginManifest(manifestPath);
	} catch {
		return null;
	}
}

export async function packagedOmxPluginVersion(
	packagedMarketplace: PackagedOmxMarketplace,
): Promise<string | null> {
	const manifest = await readPluginManifest(packagedMarketplace.pluginManifestPath);
	return typeof manifest?.version === "string" && manifest.version.trim()
		? manifest.version.trim()
		: null;
}

export async function expectedPackagedOmxSkillNames(
	packagedMarketplace: PackagedOmxMarketplace,
	options: { teamMode?: SetupTeamMode } = {},
): Promise<string[] | null> {
	const skillNames = await listChildDirectoryNames(join(packagedMarketplace.pluginRoot, "skills"));
	if (!skillNames) return null;
	return skillNames.filter((name) => (
		teamModeEnabled(options.teamMode) || !TEAM_MODE_PLUGIN_SKILL_NAMES.has(name)
	));
}

export function omxPluginCacheBase(codexHomeDir: string): string {
	return join(
		codexHomeDir,
		"plugins",
		"cache",
		OMX_LOCAL_MARKETPLACE_NAME,
		OMX_PLUGIN_NAME,
	);
}

function isMissingPathError(error: unknown): boolean {
	return (error as NodeJS.ErrnoException).code === "ENOENT";
}

/**
 * #3552: executed assets Codex loads from the plugin cache must be regular files inside a
 * regular `hooks/` directory inside a regular snapshot root. `readFile`/content equality
 * follow symlinks to their external targets before any provenance check, so a symlinked
 * `<version>` cache root or a symlinked executed asset (hooks/hooks.json,
 * hooks/codex-native-hook.mjs, hooks/omx-command.json) with byte-identical external
 * content could satisfy the unchanged fast paths while the executed bytes stayed
 * attacker-writable outside the managed namespace. Returns a human-readable reason when
 * provenance is broken (missing/symlinked/non-regular root, hooks dir, or asset), or
 * null when the snapshot's provenance is intact. Callers treat non-null as fail-closed.
 */
export async function omxPluginCacheExecutedAssetProvenanceReason(
	cacheDir: string,
): Promise<string | null> {
	const expectations: Array<{ path: string; kind: "file" | "directory"; label: string }> = [
		{ path: cacheDir, kind: "directory", label: "cache root" },
		{ path: join(cacheDir, "hooks"), kind: "directory", label: "hooks directory" },
		{ path: join(cacheDir, "hooks", "hooks.json"), kind: "file", label: "executed cache asset" },
		{ path: join(cacheDir, "hooks", "codex-native-hook.mjs"), kind: "file", label: "executed cache asset" },
		{ path: join(cacheDir, "hooks", OMX_PLUGIN_HOOK_LAUNCHER_FILE), kind: "file", label: "executed cache asset" },
	];
	for (const { path, kind, label } of expectations) {
		let stats;
		try {
			stats = await lstat(path);
		} catch {
			return `${label} is missing at ${path}`;
		}
		const shapeOk = kind === "directory"
			? stats.isDirectory() && !stats.isSymbolicLink()
			: stats.isFile() && !stats.isSymbolicLink();
		if (!shapeOk) {
			return `${label} at ${path} is a symlink or not a ${kind === "directory" ? "directory" : "regular file"}`;
		}
	}
	return null;
}

async function omxPluginCacheManifestProvenanceReason(
	cacheDir: string,
	expectedVersion?: string,
): Promise<string | null> {
	const manifestDir = join(cacheDir, ".codex-plugin");
	const manifestPath = join(manifestDir, "plugin.json");
	let manifestDirStats;
	try {
		manifestDirStats = await lstat(manifestDir);
	} catch {
		return `plugin manifest directory is missing at ${manifestDir}`;
	}
	if (!manifestDirStats.isDirectory() || manifestDirStats.isSymbolicLink()) {
		return `plugin manifest directory at ${manifestDir} is a symlink or not a directory`;
	}
	let manifestStats;
	try {
		manifestStats = await lstat(manifestPath);
	} catch {
		return `plugin manifest is missing at ${manifestPath}`;
	}
	if (!manifestStats.isFile() || manifestStats.isSymbolicLink()) {
		return `plugin manifest at ${manifestPath} is a symlink or not a regular file`;
	}
	const manifest = await readPluginManifest(manifestPath);
	if (!manifest) return `plugin manifest at ${manifestPath} is unreadable or invalid JSON`;
	if (manifest.name !== OMX_PLUGIN_NAME) {
		return `plugin manifest name is not ${OMX_PLUGIN_NAME} at ${manifestPath}`;
	}
	if (typeof manifest.version !== "string" || (expectedVersion !== undefined && manifest.version !== expectedVersion)) {
		return `plugin manifest version is not ${expectedVersion ?? "a valid string"} at ${manifestPath}`;
	}
	if (manifest.skills !== "./skills/") {
		return `plugin manifest skills pointer is not ./skills/ at ${manifestPath}`;
	}
	if (manifest.hooks !== "./hooks/hooks.json") {
		return `plugin manifest hooks pointer is not ./hooks/hooks.json at ${manifestPath}`;
	}
	if (manifest.mcpServers !== "./.mcp.json") {
		return `plugin manifest mcpServers pointer is not ./.mcp.json at ${manifestPath}`;
	}
	if (manifest.apps !== "./.app.json") {
		return `plugin manifest apps pointer is not ./.app.json at ${manifestPath}`;
	}
	return null;
}

async function omxPluginCacheSkillsProvenanceReason(
	cacheDir: string,
	packagedMarketplace: PackagedOmxMarketplace,
	expectedSkillNames: string[],
): Promise<string | null> {
	const skillsDir = join(cacheDir, "skills");
	let skillsStats;
	try {
		skillsStats = await lstat(skillsDir);
	} catch {
		return `skills directory is missing at ${skillsDir}`;
	}
	if (!skillsStats.isDirectory() || skillsStats.isSymbolicLink()) {
		return `skills directory at ${skillsDir} is a symlink or not a directory`;
	}
	for (const skillName of expectedSkillNames) {
		const skillDir = join(skillsDir, skillName);
		let skillDirStats;
		try {
			skillDirStats = await lstat(skillDir);
		} catch {
			return `expected skill directory is missing at ${skillDir}`;
		}
		if (!skillDirStats.isDirectory() || skillDirStats.isSymbolicLink()) {
			return `expected skill directory at ${skillDir} is a symlink or not a directory`;
		}
		const cachedSkill = join(skillDir, "SKILL.md");
		const packagedSkill = join(packagedMarketplace.pluginRoot, "skills", skillName, "SKILL.md");
		let cachedSkillStats;
		try {
			cachedSkillStats = await lstat(cachedSkill);
		} catch {
			return `expected skill file is missing at ${cachedSkill}`;
		}
		if (!cachedSkillStats.isFile() || cachedSkillStats.isSymbolicLink()) {
			return `expected skill file at ${cachedSkill} is a symlink or not a regular file`;
		}
		if (!(await fileContentsEqual(cachedSkill, packagedSkill))) {
			return `expected skill file content differs at ${cachedSkill}`;
		}
	}
	return null;
}

async function omxPluginCacheCompanionMetadataProvenanceReason(
	cacheDir: string,
	packagedMarketplace: PackagedOmxMarketplace,
): Promise<string | null> {
	for (const [name, relativePath] of [["mcpServers", ".mcp.json"], ["apps", ".app.json"]] as const) {
		const cachedPath = join(cacheDir, relativePath);
		let stats;
		try {
			stats = await lstat(cachedPath);
		} catch {
			return `plugin manifest ${name} companion file is missing at ${cachedPath}`;
		}
		if (!stats.isFile() || stats.isSymbolicLink()) {
			return `plugin manifest ${name} companion file at ${cachedPath} is a symlink or not a regular file`;
		}
		if (!(await fileContentsEqual(cachedPath, join(packagedMarketplace.pluginRoot, relativePath)))) {
			return `plugin manifest ${name} companion file content differs at ${cachedPath}`;
		}
	}
	return null;
}

export async function omxPluginCacheProvenanceReason(
	cacheDir: string,
	packagedMarketplace: PackagedOmxMarketplace,
	expectedVersion?: string,
	options: { teamMode?: SetupTeamMode } = {},
): Promise<string | null> {
	const manifestReason = await omxPluginCacheManifestProvenanceReason(cacheDir, expectedVersion);
	if (manifestReason) return manifestReason;
	const companionReason = await omxPluginCacheCompanionMetadataProvenanceReason(cacheDir, packagedMarketplace);
	if (companionReason) return companionReason;
	const expectedSkillNames = await expectedPackagedOmxSkillNames(packagedMarketplace, options);
	if (!expectedSkillNames) return "packaged skill names are unavailable";
	const skillsReason = await omxPluginCacheSkillsProvenanceReason(cacheDir, packagedMarketplace, expectedSkillNames);
	if (skillsReason) return skillsReason;
	return omxPluginCacheExecutedAssetProvenanceReason(cacheDir);
}

/**
 * Only the namespace OMX owns below the Codex home is required to be free of symlinks; a symlinked
 * `plugins/` (or any component under the home) can redirect writes and is refused. Everything above
 * the home belongs to the platform or the user — macOS resolves TMPDIR through `/var -> /private/var`,
 * and symlinked home directories are ordinary — so those components are canonicalized, not rejected.
 */
async function ensureManagedCacheNamespace(
	cacheBase: string,
	codexHomeDir: string,
): Promise<void> {
	const managedNamespace = relative(resolve(codexHomeDir), resolve(cacheBase));
	if (!managedNamespace || managedNamespace.startsWith("..") || isAbsolute(managedNamespace)) {
		throw new Error(
			`Refusing to mutate an OMX plugin cache outside the Codex home: ${resolve(cacheBase)}`,
		);
	}
	await mkdir(codexHomeDir, { recursive: true });
	let current = await realpath(codexHomeDir);
	for (const component of managedNamespace.split(sep).filter(Boolean)) {
		current = join(current, component);
		try {
			const stats = await lstat(current);
			if (!stats.isDirectory() || stats.isSymbolicLink()) {
				throw new Error(
					`Refusing to mutate OMX plugin cache through a non-directory namespace component: ${current}`,
				);
			}
		} catch (error) {
			if (!isMissingPathError(error)) throw error;
			await mkdir(current);
			const stats = await lstat(current);
			if (!stats.isDirectory() || stats.isSymbolicLink()) {
				throw new Error(
					`Refusing to mutate OMX plugin cache through a non-directory namespace component: ${current}`,
				);
			}
		}
	}
}

async function inspectCacheRoot(cacheDir: string): Promise<"missing" | "directory" | "foreign" | "untrusted"> {
		try {
			const stats = await lstat(cacheDir);
			if (!stats.isDirectory() || stats.isSymbolicLink()) {
				return "untrusted";
			}
			const manifest = await readPluginManifest(join(cacheDir, ".codex-plugin", "plugin.json"));
			return manifest?.name === OMX_PLUGIN_NAME ? "directory" : "foreign";
		} catch (error) {
			if (isMissingPathError(error)) return "missing";
			throw error;
		}
}

async function stageCompletePluginSnapshot(
	stagingParent: string,
	packagedMarketplace: PackagedOmxMarketplace,
	version: string,
	teamMode: SetupTeamMode | undefined,
): Promise<string> {
	const snapshotDir = join(stagingParent, "snapshot");
	await cp(packagedMarketplace.pluginRoot, snapshotDir, { recursive: true });
	await applyTeamModeToPluginCache(snapshotDir, teamMode);
	await writePinnedHookLauncher(snapshotDir, packagedMarketplace);
	const manifest = await readPluginManifest(join(snapshotDir, ".codex-plugin", "plugin.json"));
	if (
		manifest?.name !== OMX_PLUGIN_NAME ||
		manifest.version !== version ||
		manifest.skills !== "./skills/" ||
		manifest.hooks !== "./hooks/hooks.json" ||
		!(await pathIsDirectory(join(snapshotDir, "hooks"))) ||
		!(await pathIsDirectory(join(snapshotDir, "skills")))
	) {
		throw new Error(`Packaged OMX plugin snapshot is incomplete or has invalid provenance: ${snapshotDir}`);
	}
	return snapshotDir;
}

export async function discoverOmxPluginCacheDirs(
	codexHomeDir: string,
): Promise<string[]> {
	const cacheRoot = join(codexHomeDir, "plugins", "cache");
	if (!existsSync(cacheRoot)) return [];

	const queue: Array<{ path: string; depth: number }> = [
		{ path: cacheRoot, depth: 0 },
	];
	const maxDepth = 5;
	const matches: string[] = [];

	while (queue.length > 0) {
		const current = queue.shift();
		if (!current) break;

		const manifestPath = join(current.path, ".codex-plugin", "plugin.json");
		if (existsSync(manifestPath)) {
			const manifest = await readPluginManifest(manifestPath);
			if (manifest?.name === OMX_PLUGIN_NAME) {
				matches.push(current.path);
				continue;
			}
		}

		if (current.depth >= maxDepth) continue;

		let entries;
		try {
			entries = await readdir(current.path, { withFileTypes: true });
		} catch {
			continue;
		}

		for (const entry of entries) {
			if (!entry.isDirectory()) continue;
			if (entry.name === ".git" || entry.name === "node_modules") continue;
			queue.push({
				path: join(current.path, entry.name),
				depth: current.depth + 1,
			});
		}
	}

	return matches.sort();
}

export interface OmxPluginCacheState {
	cacheDir: string;
	manifestVersion: string | null;
	skillsPointer: string | null;
	skillNames: string[] | null;
	hooksPointer: string | null;
	mcpServersPointer: string | null;
	appsPointer: string | null;
	hookLauncherPinned: boolean;
}

export async function readOmxPluginCacheState(
	cacheDir: string,
	expectedVersion?: string,
): Promise<OmxPluginCacheState | null> {
	// #3552: never read cache state through a symlinked or non-directory snapshot root —
	// readFile-based manifest reads would follow an external target before provenance checks.
	// A missing pinned launcher is reported by the dedicated launcher checks, not here.
	if (
		(await omxPluginCacheExecutedAssetProvenanceReason(cacheDir))?.startsWith(
			"cache root",
		)
	) {
		return null;
	}
	const manifest = await readRegularOmxPluginCacheManifest(cacheDir);
	if (manifest?.name !== OMX_PLUGIN_NAME) return null;
	if (expectedVersion !== undefined && manifest.version !== expectedVersion) return null;
	return {
		cacheDir,
		manifestVersion:
			typeof manifest.version === "string" ? manifest.version : null,
		skillsPointer: typeof manifest.skills === "string" ? manifest.skills : null,
		skillNames: await listRegularChildDirectoryNames(join(cacheDir, "skills")),
		hooksPointer: typeof manifest.hooks === "string" ? manifest.hooks : null,
		mcpServersPointer: typeof manifest.mcpServers === "string" ? manifest.mcpServers : null,
		appsPointer: typeof manifest.apps === "string" ? manifest.apps : null,
		hookLauncherPinned: existsSync(
			join(cacheDir, "hooks", OMX_PLUGIN_HOOK_LAUNCHER_FILE),
		),
	};
}

export async function hasExpectedOmxPluginCache(
	codexHomeDir: string,
	packagedMarketplace: PackagedOmxMarketplace,
	options: { teamMode?: SetupTeamMode } = {},
): Promise<boolean> {
	const [version, expectedSkillNames] = await Promise.all([
		packagedOmxPluginVersion(packagedMarketplace),
		expectedPackagedOmxSkillNames(packagedMarketplace, options),
	]);
	if (!version || !expectedSkillNames) return false;
	const state = await readOmxPluginCacheState(
		join(omxPluginCacheBase(codexHomeDir), version),
		version,
	);
	if (
		state?.manifestVersion !== version ||
		state.skillsPointer !== "./skills/" ||
		state.hooksPointer !== "./hooks/hooks.json" ||
		!state.hookLauncherPinned ||
		!existsSync(join(state.cacheDir, "hooks", "hooks.json")) ||
		!existsSync(join(state.cacheDir, "hooks", "codex-native-hook.mjs")) ||
		JSON.stringify(state.skillNames) !== JSON.stringify(expectedSkillNames)
	) {
		return false;
	}
	if (await omxPluginCacheProvenanceReason(state.cacheDir, packagedMarketplace, version, options)) {
		return false;
	}

	return pluginHookCacheMatchesPackaged(state.cacheDir, packagedMarketplace);
}

async function fileContentsEqual(leftPath: string, rightPath: string): Promise<boolean> {
	try {
		const [left, right] = await Promise.all([
			readFile(leftPath),
			readFile(rightPath),
		]);
		return left.equals(right);
	} catch {
		return false;
	}
}


/**
 * Compares only plugin-scoped hook assets that Codex executes from the cache.
 * Manifest pointers and skill lists are validated by callers before using this
 * as a hook/launcher freshness predicate.
 *
 * #3552: the comparison is fail-closed about provenance — every executed asset
 * is lstat-validated as a regular file before it is read, so a symlinked asset
 * with byte-identical external content can no longer satisfy the unchanged
 * fast paths. `false` here means "do not trust this cache snapshot".
 */
export async function pluginHookCacheMatchesPackaged(
	cacheDir: string,
	packagedMarketplace: PackagedOmxMarketplace,
): Promise<boolean> {
	if ((await omxPluginCacheExecutedAssetProvenanceReason(cacheDir)) !== null) {
		return false;
	}
	return await fileContentsEqual(
		join(cacheDir, "hooks", "hooks.json"),
		join(packagedMarketplace.pluginRoot, "hooks", "hooks.json"),
	) && await fileContentsEqual(
		join(cacheDir, "hooks", "codex-native-hook.mjs"),
		join(packagedMarketplace.pluginRoot, "hooks", "codex-native-hook.mjs"),
	) && await pinnedHookLauncherMatchesPackaged(
		cacheDir,
		packagedMarketplace,
	);
}

function buildPinnedHookLauncherContent(
	packagedMarketplace: PackagedOmxMarketplace,
): string {
	return `${JSON.stringify(
		{
			command: process.execPath,
			argsPrefix: [join(packagedMarketplace.packageRoot, "dist", "cli", "omx.js")],
		},
		null,
		2,
	)}\n`;
}

async function pinnedHookLauncherMatchesPackaged(
	cacheDir: string,
	packagedMarketplace: PackagedOmxMarketplace,
): Promise<boolean> {
	try {
		return await readFile(
			join(cacheDir, "hooks", OMX_PLUGIN_HOOK_LAUNCHER_FILE),
			"utf-8",
		) === buildPinnedHookLauncherContent(packagedMarketplace);
	} catch {
		return false;
	}
}

async function writePinnedHookLauncher(
	cacheDir: string,
	packagedMarketplace: PackagedOmxMarketplace,
): Promise<void> {
	await writeFile(
		join(cacheDir, "hooks", OMX_PLUGIN_HOOK_LAUNCHER_FILE),
		buildPinnedHookLauncherContent(packagedMarketplace),
	);
}

async function pathIsDirectory(path: string): Promise<boolean> {
	try {
		return (await lstat(path)).isDirectory();
	} catch {
		return false;
	}
}

async function applyTeamModeToPluginCache(
	cacheDir: string,
	teamMode: SetupTeamMode | undefined,
): Promise<void> {
	if (teamModeEnabled(teamMode)) return;
	for (const skillName of TEAM_MODE_PLUGIN_SKILL_NAMES) {
		await rm(join(cacheDir, "skills", skillName), { recursive: true, force: true });
	}
}

export interface OmxPluginCacheMaterializeResult {
	status: "unavailable" | "unchanged" | "materialized" | "stale-launcher";
	cacheDir?: string;
	version?: string;
	retiredDirs?: string[];
	reason?: string;
	launcherTarget?: string;
}

export const PLUGIN_LAUNCHER_RECOVERY_HINT = "codex plugin remove oh-my-codex@oh-my-codex-local --json";

async function canonicalRealpath(path: string): Promise<string | null> {
	try {
		return await realpath(path);
	} catch {
		return null;
	}
}

export async function readPinnedLauncherRaw(cacheDir: string): Promise<{ raw: string | null; parsed: { command?: unknown; argsPrefix?: unknown } | null; error?: string }> {
	const launcherPath = join(cacheDir, "hooks", OMX_PLUGIN_HOOK_LAUNCHER_FILE);
	try {
		const raw = await readFile(launcherPath, "utf-8");
		try {
			const parsed = JSON.parse(raw) as { command?: unknown; argsPrefix?: unknown };
			if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
				return { raw, parsed: null, error: `malformed pinned launcher JSON: expected object but got ${Array.isArray(parsed) ? "array" : String(parsed)}` };
			}
			return { raw, parsed, error: undefined };
		} catch (e) {
			return { raw, parsed: null, error: `malformed pinned launcher JSON: ${(e as Error).message}` };
		}
	} catch (e) {
		if (isMissingPathError(e)) return { raw: null, parsed: null, error: "missing pinned launcher" };
		return { raw: null, parsed: null, error: `cannot read pinned launcher: ${(e as Error).message}` };
	}
}

export async function getPinnedLauncherIncompatibilityReason(
	cacheDir: string,
	packagedMarketplace: PackagedOmxMarketplace,
): Promise<{ reason: string; target?: string } | null> {
	const launcherPath = join(cacheDir, "hooks", OMX_PLUGIN_HOOK_LAUNCHER_FILE);
	let raw: string;
	try {
		raw = await readFile(launcherPath, "utf-8");
	} catch (e) {
		if (isMissingPathError(e)) return { reason: `pinned launcher missing at ${launcherPath}; run ${PLUGIN_LAUNCHER_RECOVERY_HINT} then rerun omx setup --plugin` };
		return { reason: `cannot read pinned launcher at ${launcherPath}: ${(e as Error).message}; run ${PLUGIN_LAUNCHER_RECOVERY_HINT} then rerun omx setup --plugin` };
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw) as unknown;
	} catch (e) {
		return { reason: `pinned launcher at ${launcherPath} is malformed JSON (${(e as Error).message}); run ${PLUGIN_LAUNCHER_RECOVERY_HINT} then rerun omx setup --plugin` };
	}
	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
		return { reason: `pinned launcher at ${launcherPath} is malformed JSON (expected object but got ${Array.isArray(parsed) ? "array" : String(parsed)}); run ${PLUGIN_LAUNCHER_RECOVERY_HINT} then rerun omx setup --plugin` };
	}
	const obj = parsed as { command?: unknown; argsPrefix?: unknown };
	const extraKeys = Object.keys(obj).filter((key) => key !== "command" && key !== "argsPrefix");
	if (extraKeys.length > 0) {
		return { reason: `pinned launcher at ${launcherPath} has extra keys (${extraKeys.sort().join(", ")}); run ${PLUGIN_LAUNCHER_RECOVERY_HINT} then rerun omx setup --plugin` };
	}
	if (typeof obj.command !== "string" || obj.command.trim() === "") {
		return { reason: `pinned launcher at ${launcherPath} has invalid command; run ${PLUGIN_LAUNCHER_RECOVERY_HINT} then rerun omx setup --plugin` };
	}
	if (!Array.isArray(obj.argsPrefix) || obj.argsPrefix.length !== 1 || typeof obj.argsPrefix[0] !== "string" || obj.argsPrefix[0].trim() === "") {
		return { reason: `pinned launcher at ${launcherPath} has invalid argsPrefix (expected exactly one packaged omx.js target); run ${PLUGIN_LAUNCHER_RECOVERY_HINT} then rerun omx setup --plugin` };
	}
	const command = obj.command.trim();
	const target = (obj.argsPrefix as string[])[0]!;
	// Validate command field (generated launcher contract) — fail-closed on dead/mismatched executable
	if (!isAbsolute(command)) {
		return { reason: `pinned launcher command is not absolute: ${command}; run ${PLUGIN_LAUNCHER_RECOVERY_HINT} then rerun omx setup --plugin`, target };
	}
	if (!existsSync(command)) {
		return { reason: `pinned launcher command does not exist: ${command}; run ${PLUGIN_LAUNCHER_RECOVERY_HINT} then rerun omx setup --plugin`, target };
	}
	const expectedCommand = process.execPath;
	const [canonicalActualCommand, canonicalExpectedCommand] = await Promise.all([
		canonicalRealpath(command),
		canonicalRealpath(expectedCommand),
	]);
	if (canonicalActualCommand === null || canonicalExpectedCommand === null || canonicalActualCommand !== canonicalExpectedCommand) {
		return { reason: `pinned launcher command provenance mismatch: expected ${expectedCommand} but found ${command} (different Node executable); run ${PLUGIN_LAUNCHER_RECOVERY_HINT} then rerun omx setup --plugin`, target };
	}
	if (!isAbsolute(target)) {
		return { reason: `pinned launcher target is not absolute: ${target}; run ${PLUGIN_LAUNCHER_RECOVERY_HINT} then rerun omx setup --plugin`, target };
	}
	if (!existsSync(target)) {
		return { reason: `pinned launcher target does not exist: ${target} (package root removed?); run ${PLUGIN_LAUNCHER_RECOVERY_HINT} then rerun omx setup --plugin`, target };
	}
	const expectedTarget = join(packagedMarketplace.packageRoot, "dist", "cli", "omx.js");
	const [canonicalActual, canonicalExpected] = await Promise.all([
		canonicalRealpath(target),
		canonicalRealpath(expectedTarget),
	]);
	if (canonicalActual === null || canonicalExpected === null || canonicalActual !== canonicalExpected) {
		return { reason: `pinned launcher provenance mismatch: expected ${expectedTarget} but found ${target} (different package root); run ${PLUGIN_LAUNCHER_RECOVERY_HINT} then rerun omx setup --plugin`, target };
	}
	return null;
}

async function retireUnpinnedManagedSnapshots(
	codexHomeDir: string,
	currentVersion: string,
): Promise<string[]> {
	const cacheBase = omxPluginCacheBase(codexHomeDir);
	await ensureManagedCacheNamespace(cacheBase, codexHomeDir);
	let entries;
	try {
		entries = await readdir(cacheBase, { withFileTypes: true });
	} catch {
		return [];
	}
	const managed: Array<{ path: string; version: string; mtimeMs: number }> = [];
	for (const entry of entries) {
		if (!entry.isDirectory() || entry.name === currentVersion) continue;
		const path = join(cacheBase, entry.name);
		const state = await readOmxPluginCacheState(path);
		if (state?.manifestVersion !== entry.name) continue;
		if (existsSync(join(path, ".omx-live-pin"))) continue;
		managed.push({ path, version: entry.name, mtimeMs: (await lstat(path)).mtimeMs });
	}
	managed.sort((left, right) =>
		right.version.localeCompare(left.version, undefined, { numeric: true }) ||
		right.mtimeMs - left.mtimeMs,
	);
	const retired: string[] = [];
	for (const candidate of managed.slice(1)) {
		await rm(candidate.path, { recursive: true, force: true });
		retired.push(candidate.path);
	}
	return retired;
}

export async function materializePackagedOmxPluginCache(
	codexHomeDir: string,
	packagedMarketplace: PackagedOmxMarketplace | null,
	options: { dryRun?: boolean; teamMode?: SetupTeamMode; onCacheDirPrepared?: (cacheDir: string) => void | Promise<void> } = {},
): Promise<OmxPluginCacheMaterializeResult> {
	if (!packagedMarketplace) return { status: "unavailable" };
	const version = await packagedOmxPluginVersion(packagedMarketplace);
	if (!version) return { status: "unavailable" };
	const cacheDir = join(omxPluginCacheBase(codexHomeDir), version);
	if (await hasExpectedOmxPluginCache(codexHomeDir, packagedMarketplace, options)) {
		return {
			status: "unchanged",
			cacheDir,
			version,
			retiredDirs: options.dryRun
				? []
				: await retireUnpinnedManagedSnapshots(codexHomeDir, version),
		};
	}
	// Same-version directory exists but is not byte-identical: distinguish immutable-preserved vs dead/provenance-incompatible launcher.
	// Preserve #3499 immutability: never rewrite an existing same-version directory in place.
	const rootState = await inspectCacheRoot(cacheDir);
	if (rootState === "untrusted") {
		return {
			status: "stale-launcher",
			cacheDir,
			version,
			reason: `OMX plugin cache root at ${cacheDir} is a symlink or non-directory entry; managed snapshots must be regular immutable directories; run ${PLUGIN_LAUNCHER_RECOVERY_HINT} then rerun omx setup --plugin`,
			launcherTarget: undefined,
			retiredDirs: options.dryRun ? [] : await retireUnpinnedManagedSnapshots(codexHomeDir, version),
		};
	}
	if (rootState === "directory") {
		const incompat = await getPinnedLauncherIncompatibilityReason(cacheDir, packagedMarketplace);
		if (incompat) {
			return {
				status: "stale-launcher",
				cacheDir,
				version,
				reason: incompat.reason,
				launcherTarget: incompat.target,
				retiredDirs: options.dryRun ? [] : await retireUnpinnedManagedSnapshots(codexHomeDir, version),
			};
		}
		const snapshotProvenanceReason = await omxPluginCacheProvenanceReason(
			cacheDir,
			packagedMarketplace,
			version,
			options,
		);
		if (snapshotProvenanceReason) {
			return {
				status: "stale-launcher",
				cacheDir,
				version,
				reason: `${snapshotProvenanceReason}; run ${PLUGIN_LAUNCHER_RECOVERY_HINT} then rerun omx setup --plugin`,
				launcherTarget: undefined,
				retiredDirs: options.dryRun ? [] : await retireUnpinnedManagedSnapshots(codexHomeDir, version),
			};
		}
		const assetProvenanceReason = await omxPluginCacheExecutedAssetProvenanceReason(cacheDir);
		if (assetProvenanceReason) {
			return {
				status: "stale-launcher",
				cacheDir,
				version,
				reason: `${assetProvenanceReason}; run ${PLUGIN_LAUNCHER_RECOVERY_HINT} then rerun omx setup --plugin`,
				launcherTarget: undefined,
				retiredDirs: options.dryRun ? [] : await retireUnpinnedManagedSnapshots(codexHomeDir, version),
			};
		}
		return {
			status: "unchanged",
			cacheDir,
			version,
			retiredDirs: options.dryRun ? [] : await retireUnpinnedManagedSnapshots(codexHomeDir, version),
		};
	}
	if (rootState === "foreign") {
		return { status: "unavailable", cacheDir, version };
	}
	if (!options.dryRun) {
		const cacheBase = omxPluginCacheBase(codexHomeDir);
		await ensureManagedCacheNamespace(cacheBase, codexHomeDir);
		const tempDir = await mkdtemp(join(tmpdir(), `omx-plugin-${version}-`));
		try {
			const snapshotDir = await stageCompletePluginSnapshot(
				tempDir,
				packagedMarketplace,
				version,
				options.teamMode,
			);
			await rename(snapshotDir, cacheDir);
		} finally {
			await rm(tempDir, { recursive: true, force: true });
		}
	}
	return {
		status: "materialized",
		cacheDir,
		version,
		retiredDirs: options.dryRun
			? []
			: await retireUnpinnedManagedSnapshots(codexHomeDir, version),
	};
}

function marketplaceTableHeaderPattern(): RegExp {
	return new RegExp(
		`^\\s*\\[marketplaces\\.${OMX_LOCAL_MARKETPLACE_NAME.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\]\\s*$`,
	);
}

function isTomlTableHeader(line: string): boolean {
	return /^\s*\[/.test(line);
}

function stripTomlTablesByHeaderPattern(config: string, headerPattern: RegExp): string {
	const lines = config.split(/\r?\n/);
	const result: string[] = [];

	for (let index = 0; index < lines.length; ) {
		if (headerPattern.test(lines[index])) {
			index += 1;
			while (index < lines.length && !isTomlTableHeader(lines[index])) {
				index += 1;
			}
			continue;
		}

		result.push(lines[index]);
		index += 1;
	}

	return result.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd();
}

export function stripLocalOmxMarketplaceRegistration(config: string): string {
	return stripTomlTablesByHeaderPattern(config, marketplaceTableHeaderPattern());
}

export function buildLocalOmxMarketplaceRegistration(
	packageRoot: string,
): string {
	return [
		`[marketplaces.${OMX_LOCAL_MARKETPLACE_NAME}]`,
		`source_type = "local"`,
		`source = ${JSON.stringify(packageRoot)}`,
	].join("\n");
}

export function upsertLocalOmxMarketplaceRegistration(
	config: string,
	packageRoot: string,
): string {
	const stripped = stripLocalOmxMarketplaceRegistration(config).trimEnd();
	const registration = buildLocalOmxMarketplaceRegistration(packageRoot);
	return `${stripped ? `${stripped}\n\n` : ""}${registration}\n`;
}

function localPluginTableHeaderPattern(): RegExp {
	return new RegExp(
		`^\\s*\\[plugins\\.${JSON.stringify(OMX_LOCAL_PLUGIN_CONFIG_KEY).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\]\\s*$`,
	);
}

function localPluginMcpServerTableHeaderPattern(serverName: string): RegExp {
	return new RegExp(
		`^\\s*\\[plugins\\.${JSON.stringify(OMX_LOCAL_PLUGIN_CONFIG_KEY).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\.mcp_servers\\.${serverName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\]\\s*$`,
	);
}
function localPluginScalarLinePattern(): RegExp {
	return new RegExp(
		`^\\s*${JSON.stringify(OMX_LOCAL_PLUGIN_CONFIG_KEY).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*=.*$`,
	);
}

function localPluginScalarBooleanPattern(): RegExp {
	return new RegExp(
		`^\\s*${JSON.stringify(OMX_LOCAL_PLUGIN_CONFIG_KEY).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*=\\s*(true|false)\\s*(?:#.*)?$`,
	);
}

function tomlBooleanLiteralIsTrue(value: string): boolean {
	return /^\s*true\s*(?:#.*)?$/.test(value);
}

export function hasLocalOmxPluginEnablement(config: string): boolean {
	const modernHeaderPattern = localPluginTableHeaderPattern();
	const legacyScalarPattern = localPluginScalarBooleanPattern();
	const lines = config.split(/\r?\n/);
	let inLocalPluginTable = false;
	let inPluginsTable = false;

	for (const line of lines) {
		if (isTomlTableHeader(line)) {
			inLocalPluginTable = modernHeaderPattern.test(line);
			inPluginsTable = /^\s*\[plugins\]\s*$/.test(line);
			continue;
		}

		if (inLocalPluginTable) {
			const enabled = /^\s*enabled\s*=\s*(.*)$/.exec(line);
			if (enabled && tomlBooleanLiteralIsTrue(enabled[1])) return true;
		}

		if (inPluginsTable) {
			const legacy = legacyScalarPattern.exec(line);
			if (legacy?.[1] === "true") return true;
		}
	}

	return false;
}

function removeLocalOmxPluginLegacyScalar(config: string): string {
	const scalarPattern = localPluginScalarLinePattern();
	const lines = config.split(/\r?\n/);
	const result: string[] = [];
	let inPluginsTable = false;

	for (const line of lines) {
		if (isTomlTableHeader(line)) {
			inPluginsTable = /^\s*\[plugins\]\s*$/.test(line);
			result.push(line);
			continue;
		}

		if (inPluginsTable && scalarPattern.test(line)) continue;
		result.push(line);
	}

	return result.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd();
}


export function hasLocalOmxPluginMcpServerRegistrations(config: string): boolean {
	const lines = config.split(/\r?\n/);
	return OMX_FIRST_PARTY_MCP_SERVER_NAMES.some((serverName) =>
		lines.some((line) => localPluginMcpServerTableHeaderPattern(serverName).test(line)),
	);
}

export function stripLocalOmxPluginMcpServerRegistrations(config: string): string {
	let next = config;
	for (const serverName of OMX_FIRST_PARTY_MCP_SERVER_NAMES) {
		next = stripTomlTablesByHeaderPattern(
			next,
			localPluginMcpServerTableHeaderPattern(serverName),
		);
	}
	return next;
}

function upsertTomlTableBooleanKey(
	config: string,
	header: string,
	headerPattern: RegExp,
	key: string,
	value: boolean,
	options: { create: boolean },
): string {
	const lines = config.split(/\r?\n/);
	const start = lines.findIndex((line) => headerPattern.test(line));

	if (start < 0) {
		if (!options.create) return config;
		const base = config.trimEnd();
		return `${base ? `${base}\n\n` : ""}${header}\n${key} = ${value ? "true" : "false"}\n`;
	}

	let end = lines.length;
	for (let index = start + 1; index < lines.length; index += 1) {
		if (isTomlTableHeader(lines[index])) {
			end = index;
			break;
		}
	}

	let keyIndex = -1;
	for (let index = start + 1; index < end; index += 1) {
		if (new RegExp(`^\\s*${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*=`).test(lines[index])) {
			if (keyIndex < 0) {
				keyIndex = index;
				lines[index] = `${key} = ${value ? "true" : "false"}`;
			} else {
				lines.splice(index, 1);
				index -= 1;
				end -= 1;
			}
		}
	}

	if (keyIndex < 0) {
		lines.splice(start + 1, 0, `${key} = ${value ? "true" : "false"}`);
	}

	return lines.join("\n").replace(/\n*$/, "\n");
}

export function upsertLocalOmxPluginEnablement(config: string): string {
	const normalized = removeLocalOmxPluginLegacyScalar(config);
	const stripped = stripTomlTablesByHeaderPattern(
		normalized,
		localPluginTableHeaderPattern(),
	).trimEnd();
	return `${stripped ? `${stripped}\n\n` : ""}[plugins.${JSON.stringify(OMX_LOCAL_PLUGIN_CONFIG_KEY)}]\nenabled = true\n`;
}

export function upsertLocalOmxPluginMcpServerEnablement(
	config: string,
	enabled: boolean,
	options: { removeWhenDisabled?: boolean } = {},
): string {
	if (!enabled && options.removeWhenDisabled) {
		const stripped = stripLocalOmxPluginMcpServerRegistrations(config);
		return stripped ? `${stripped}\n` : "";
	}
	if (!enabled) {
		return config;
	}
	let next = stripLocalOmxPluginMcpServerRegistrations(config);
	for (const serverName of OMX_FIRST_PARTY_MCP_SERVER_NAMES) {
		const header = `[plugins.${JSON.stringify(OMX_LOCAL_PLUGIN_CONFIG_KEY)}.mcp_servers.${serverName}]`;
		const headerPattern = localPluginMcpServerTableHeaderPattern(serverName);
		next = upsertTomlTableBooleanKey(next, header, headerPattern, "enabled", enabled, {
			create: enabled,
		});
	}
	return next;
}
