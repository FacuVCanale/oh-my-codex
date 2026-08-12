import { existsSync } from "fs";
import { cp, lstat, mkdir, mkdtemp, readdir, readFile, rename, rm, writeFile } from "fs/promises";
import { join, resolve, sep } from "path";
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

async function ensureManagedCacheNamespace(cacheBase: string): Promise<void> {
	const absoluteBase = resolve(cacheBase);
	const root = absoluteBase.startsWith(sep) ? sep : "";
	let current = root;
	for (const component of absoluteBase.slice(root.length).split(sep).filter(Boolean)) {
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

async function inspectCacheRoot(cacheDir: string): Promise<"missing" | "directory" | "foreign"> {
		try {
			const stats = await lstat(cacheDir);
			if (!stats.isDirectory() || stats.isSymbolicLink()) {
				throw new Error(`Refusing to mutate non-directory OMX plugin cache root: ${cacheDir}`);
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
	hookLauncherPinned: boolean;
}

export async function readOmxPluginCacheState(
	cacheDir: string,
): Promise<OmxPluginCacheState | null> {
	const manifest = await readPluginManifest(
		join(cacheDir, ".codex-plugin", "plugin.json"),
	);
	if (manifest?.name !== OMX_PLUGIN_NAME) return null;
	return {
		cacheDir,
		manifestVersion:
			typeof manifest.version === "string" ? manifest.version : null,
		skillsPointer: typeof manifest.skills === "string" ? manifest.skills : null,
		skillNames: await listChildDirectoryNames(join(cacheDir, "skills")),
		hooksPointer: typeof manifest.hooks === "string" ? manifest.hooks : null,
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
 */
export async function pluginHookCacheMatchesPackaged(
	cacheDir: string,
	packagedMarketplace: PackagedOmxMarketplace,
): Promise<boolean> {
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
	status: "unavailable" | "unchanged" | "materialized";
	cacheDir?: string;
	version?: string;
	retiredDirs?: string[];
}

async function retireUnpinnedManagedSnapshots(
	cacheBase: string,
	currentVersion: string,
): Promise<string[]> {
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
				: await retireUnpinnedManagedSnapshots(omxPluginCacheBase(codexHomeDir), version),
		};
	}
	if (!options.dryRun) {
		const cacheBase = omxPluginCacheBase(codexHomeDir);
		await ensureManagedCacheNamespace(cacheBase);
		const rootState = await inspectCacheRoot(cacheDir);
		if (rootState === "foreign") {
			return { status: "unavailable", cacheDir, version };
		}
		const tempDir = await mkdtemp(join(tmpdir(), `omx-plugin-${version}-`));
		try {
			const snapshotDir = await stageCompletePluginSnapshot(
				tempDir,
				packagedMarketplace,
				version,
				options.teamMode,
			);
			if (rootState === "directory") return { status: "unchanged", cacheDir, version };
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
			: await retireUnpinnedManagedSnapshots(omxPluginCacheBase(codexHomeDir), version),
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
