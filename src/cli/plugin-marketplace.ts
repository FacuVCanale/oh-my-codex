import { constants as fsConstants, existsSync, type Stats } from "fs";
import { cp, lstat, mkdir, mkdtemp, open, readdir, readFile, realpath, rename, rm, writeFile, type FileHandle } from "fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "path";
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

function directoryFdPath(fd: number): string | null {
	if (process.platform === "linux") return `/proc/self/fd/${fd}`;
	if (process.platform === "darwin") return `/dev/fd/${fd}`;
	return null;
}

function isDirectoryDescriptorPath(path: string): boolean {
	return /^\/(?:proc\/self\/fd|dev\/fd)\/\d+$/.test(path);
}

function directoryOpenFlags(path: string, directoryFlags: number, noFollowFlags: number): number {
	return fsConstants.O_RDONLY | directoryFlags | (isDirectoryDescriptorPath(path) ? 0 : noFollowFlags);
}

async function syncRegularFile(path: string): Promise<void> {
	const noFollowFlags = fsConstants.O_NOFOLLOW;
	if (typeof noFollowFlags !== "number") throw new Error("O_NOFOLLOW is unavailable");
	const handle = await open(path, fsConstants.O_RDONLY | noFollowFlags);
	try {
		await handle.sync();
	} finally {
		await handle.close();
	}
}

async function syncDirectory(path: string): Promise<void> {
	const noFollowFlags = fsConstants.O_NOFOLLOW;
	const directoryFlags = fsConstants.O_DIRECTORY;
	if (typeof noFollowFlags !== "number" || typeof directoryFlags !== "number") {
		throw new Error("directory durability flags are unavailable");
	}
	const handle = await open(path, directoryOpenFlags(path, directoryFlags, noFollowFlags));
	try {
		await handle.sync();
	} finally {
		await handle.close();
	}
}

async function syncDirectoryTree(path: string, directoryHandle?: FileHandle): Promise<void> {
	const entries = await readdir(path, { withFileTypes: true });
	for (const entry of entries) {
		const childPath = join(path, entry.name);
		if (entry.isSymbolicLink()) throw new Error(`cannot sync symlinked cache entry: ${childPath}`);
		if (entry.isDirectory()) await syncDirectoryTree(childPath);
		else await syncRegularFile(childPath);
	}
	if (directoryHandle) await directoryHandle.sync();
	else await syncDirectory(path);
}

export async function readOmxPluginCacheFileNoFollow(
	path: string,
	options: { requireSingleLink?: boolean; anchorDir?: string } = {},
): Promise<Buffer | null> {
	let handle: FileHandle | undefined;
	let anchorHandle: FileHandle | undefined;
	const intermediateDirectories: Array<{ handle: FileHandle; path: string; stats: Stats }> = [];
	try {
		const requireSingleLink = options.requireSingleLink ?? true;
		const noFollowFlags = fsConstants.O_NOFOLLOW;
		if (typeof noFollowFlags !== "number") return null;
		let readPath = path;
		let anchorBefore: Stats | null = null;
		if (options.anchorDir) {
			const directoryFlags = fsConstants.O_DIRECTORY;
			if (typeof directoryFlags !== "number") return null;
			anchorHandle = await open(options.anchorDir, directoryOpenFlags(options.anchorDir, directoryFlags, noFollowFlags));
			anchorBefore = await anchorHandle.stat();
			if (!anchorBefore.isDirectory()) return null;
			if (typeof anchorBefore.dev !== "number" || typeof anchorBefore.ino !== "number") return null;
			const fdPath = process.platform === "darwin"
				? resolve(options.anchorDir)
				: directoryFdPath(anchorHandle.fd);
			if (!fdPath) return null;
			const relativePath = relative(resolve(options.anchorDir), resolve(path));
			if (!relativePath || relativePath.startsWith("..")) return null;
			const components = relativePath.split(sep);
			if (components.some((component) => !component || component === "." || component === "..")) return null;
			let parentPath = fdPath;
			for (const component of components.slice(0, -1)) {
				const childPath = join(parentPath, component);
				const childHandle = await open(childPath, fsConstants.O_RDONLY | directoryFlags | noFollowFlags);
				const childStats = await childHandle.stat();
				if (!childStats.isDirectory() || childStats.isSymbolicLink()) {
					await childHandle.close();
					return null;
				}
				intermediateDirectories.push({ handle: childHandle, path: childPath, stats: childStats });
				parentPath = process.platform === "darwin" ? childPath : directoryFdPath(childHandle.fd) ?? "";
				if (!parentPath) return null;
			}
			readPath = join(parentPath, components.at(-1)!);
		}
		const parentDescriptor = intermediateDirectories.at(-1)?.handle ?? anchorHandle;
		const parentBefore = parentDescriptor ? await parentDescriptor.stat() : await lstat(resolve(readPath, ".."));
		if (!parentBefore.isDirectory() || parentBefore.isSymbolicLink()) return null;
		if (typeof parentBefore.dev !== "number" || typeof parentBefore.ino !== "number") return null;
		const before = await lstat(readPath);
		if (!before.isFile() || before.isSymbolicLink()) return null;
		if (requireSingleLink && before.nlink !== 1) return null;
		if (typeof before.dev !== "number" || typeof before.ino !== "number") return null;
		handle = await open(readPath, fsConstants.O_RDONLY | noFollowFlags);
		const descriptorStats = await handle.stat();
		if (!descriptorStats.isFile()) return null;
		if (requireSingleLink && descriptorStats.nlink !== 1) return null;
		if (descriptorStats.dev !== before.dev || descriptorStats.ino !== before.ino) return null;
		const bytes = await handle.readFile();
		const after = await lstat(readPath);
		const parentAfter = parentDescriptor ? await parentDescriptor.stat() : await lstat(resolve(readPath, ".."));
		if (!parentAfter) return null;
		if (!after.isFile() || after.isSymbolicLink()) return null;
		if (requireSingleLink && after.nlink !== 1) return null;
		if (typeof after.dev !== "number" || typeof after.ino !== "number") return null;
		if (after.dev !== before.dev || after.ino !== before.ino) return null;
		if (!parentAfter.isDirectory() || parentAfter.isSymbolicLink()) return null;
		if (typeof parentAfter.dev !== "number" || typeof parentAfter.ino !== "number" || parentAfter.dev !== parentBefore.dev || parentAfter.ino !== parentBefore.ino) return null;
		for (const directory of intermediateDirectories) {
			const currentStats = await lstat(directory.path);
			if (!currentStats.isDirectory() || currentStats.isSymbolicLink() || typeof currentStats.dev !== "number" || typeof currentStats.ino !== "number" || currentStats.dev !== directory.stats.dev || currentStats.ino !== directory.stats.ino) return null;
		}
		if (options.anchorDir && anchorBefore) {
			const anchorAfter = isDirectoryDescriptorPath(options.anchorDir)
				? await anchorHandle!.stat()
				: await lstat(options.anchorDir);
			if (!anchorAfter.isDirectory() || (!isDirectoryDescriptorPath(options.anchorDir) && anchorAfter.isSymbolicLink()) || typeof anchorAfter.dev !== "number" || typeof anchorAfter.ino !== "number" || anchorAfter.dev !== anchorBefore.dev || anchorAfter.ino !== anchorBefore.ino) return null;
		}
		return bytes;
	} catch {
		return null;
	} finally {
		if (handle) await handle.close();
		for (const directory of intermediateDirectories.reverse()) await directory.handle.close();
		if (anchorHandle) await anchorHandle.close();
	}
}

async function readRegularFileTextNoFollow(path: string, options: { anchorDir?: string } = {}): Promise<string | null> {
	const bytes = await readOmxPluginCacheFileNoFollow(path, options);
	return bytes?.toString("utf-8") ?? null;
}

async function hasRegularPublicationMarker(cacheDir: string, name: ".omx-complete" | ".omx-incomplete"): Promise<boolean> {
	return (await readOmxPluginCacheFileNoFollow(join(cacheDir, name), { anchorDir: cacheDir })) !== null;
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

async function readRegularOmxPluginCacheManifest(
	cacheDir: string,
	anchorDir = cacheDir,
): Promise<PluginManifest | null> {
	const manifestDir = join(cacheDir, ".codex-plugin");
	const manifestPath = join(manifestDir, "plugin.json");
	try {
		const manifestDirStats = await lstat(manifestDir);
		if (!manifestDirStats.isDirectory() || manifestDirStats.isSymbolicLink()) return null;
		const manifestStats = await lstat(manifestPath);
		if (!manifestStats.isFile() || manifestStats.isSymbolicLink()) return null;
		const bytes = await readOmxPluginCacheFileNoFollow(manifestPath, { anchorDir });
		return bytes ? JSON.parse(bytes.toString("utf-8")) as PluginManifest : null;
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

function isProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code !== "ESRCH";
	}
}

async function claimPublicationLock(
	cacheBaseFdPath: string,
	cacheBase: string,
	noFollowFlags: number,
): Promise<FileHandle> {
	const lockPath = join(cacheBaseFdPath, ".omx-publish.lock");
	for (let attempt = 0; attempt < 2; attempt += 1) {
		try {
			const lockHandle = await open(
				lockPath,
				fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | noFollowFlags,
				0o600,
			);
			try {
				await lockHandle.writeFile(`${JSON.stringify({ pid: process.pid, createdAt: Date.now() })}\n`);
				await lockHandle.sync();
			} catch (error) {
				try { await lockHandle.close(); } catch { /* preserve the primary failure */ }
				try { await rm(lockPath, { force: true }); } catch { /* preserve the primary failure */ }
				throw error;
			}
			return lockHandle;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST" || attempt > 0) throw error;
			const lockBytes = await readOmxPluginCacheFileNoFollow(lockPath, { anchorDir: cacheBaseFdPath });
			let stale = false;
			if (lockBytes !== null) {
				try {
					const record = JSON.parse(lockBytes.toString("utf-8")) as { pid?: unknown };
					stale = typeof record.pid === "number" && Number.isInteger(record.pid) && record.pid > 0 && !isProcessAlive(record.pid);
				} catch {
					stale = false;
				}
			}
			if (!stale) {
				throw new Error(`another OMX plugin cache publication is active at ${cacheBase}; refusing concurrent publication`);
			}
			await rm(lockPath, { force: true });
		}
	}
	throw new Error(`cannot recover stale OMX plugin cache publication lock at ${cacheBase}`);
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
	if (!(await hasRegularPublicationMarker(cacheDir, ".omx-complete"))) {
		return `cache snapshot publication marker is missing at ${cacheDir}`;
	}
	if (await hasRegularPublicationMarker(cacheDir, ".omx-incomplete")) {
		return `cache snapshot publication is incomplete at ${cacheDir}`;
	}
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
			: stats.isFile() && !stats.isSymbolicLink() && stats.nlink === 1;
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
	if (!manifestStats.isFile() || manifestStats.isSymbolicLink() || manifestStats.nlink !== 1) {
		return `plugin manifest at ${manifestPath} is a symlink or not a regular file`;
	}
	const manifestBytes = await readOmxPluginCacheFileNoFollow(manifestPath, { anchorDir: cacheDir });
	let manifest: PluginManifest | null = null;
	try {
		manifest = manifestBytes ? JSON.parse(manifestBytes.toString("utf-8")) as PluginManifest : null;
	} catch {
		manifest = null;
	}
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
	let skillEntries;
	try {
		skillEntries = await readdir(skillsDir, { withFileTypes: true });
	} catch {
		return `skills directory at ${skillsDir} is unreadable`;
	}
	const actualSkillNames = skillEntries.map((entry) => entry.name).sort();
	if (skillEntries.some((entry) => entry.isSymbolicLink() || !entry.isDirectory())) {
		return `skills directory at ${skillsDir} contains a symlink or non-directory entry`;
	}
	if (JSON.stringify(actualSkillNames) !== JSON.stringify([...expectedSkillNames].sort())) {
		return `skills directory contents differ at ${skillsDir}`;
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
		if (!cachedSkillStats.isFile() || cachedSkillStats.isSymbolicLink() || cachedSkillStats.nlink !== 1) {
			return `expected skill file at ${cachedSkill} is a symlink or not a regular file`;
		}
		if (!(await fileContentsEqual(cachedSkill, packagedSkill, cacheDir))) {
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
		if (!stats.isFile() || stats.isSymbolicLink() || stats.nlink !== 1) {
			return `plugin manifest ${name} companion file at ${cachedPath} is a symlink or not a regular file`;
		}
		if (!(await fileContentsEqual(cachedPath, join(packagedMarketplace.pluginRoot, relativePath), cacheDir))) {
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

async function openManagedCacheNamespace(
	cacheBase: string,
	codexHomeDir: string,
	options: { create: boolean },
): Promise<{ handle: FileHandle; fdPath: string; handles: FileHandle[] } | null> {
	const managedNamespace = relative(resolve(codexHomeDir), resolve(cacheBase));
	if (!managedNamespace || managedNamespace.startsWith("..") || isAbsolute(managedNamespace)) {
		throw new Error(`Refusing to access an OMX plugin cache outside the Codex home: ${resolve(cacheBase)}`);
	}
	const noFollowFlags = fsConstants.O_NOFOLLOW;
	const directoryFlags = fsConstants.O_DIRECTORY;
	if (typeof noFollowFlags !== "number" || typeof directoryFlags !== "number") {
		throw new Error("platform cannot provide no-follow directory anchoring for the OMX plugin cache namespace");
	}
	if (options.create) await mkdir(codexHomeDir, { recursive: true });
	let homeRealpath: string;
	try {
		homeRealpath = await realpath(codexHomeDir);
	} catch (error) {
		if (isMissingPathError(error) && !options.create) return null;
		throw error;
	}
	const handles: FileHandle[] = [];
	try {
		const homeHandle = await open(homeRealpath, directoryOpenFlags(homeRealpath, directoryFlags, noFollowFlags));
		handles.push(homeHandle);
		let parentPath = process.platform === "darwin" ? homeRealpath : directoryFdPath(homeHandle.fd);
		let actualParentPath = homeRealpath;
		if (!parentPath) throw new Error("platform cannot expose a Codex home directory descriptor");
		for (const component of managedNamespace.split(sep).filter(Boolean)) {
			const childPath = join(parentPath, component);
			const actualChildPath = join(actualParentPath, component);
			const childOpenPath = process.platform === "darwin" ? actualChildPath : childPath;
			const openChild = async (): Promise<FileHandle> => {
				if (process.platform === "darwin") {
					const parentStats = await handles.at(-1)!.stat();
					const visibleParentStats = await lstat(actualParentPath);
					if (parentStats.dev !== visibleParentStats.dev || parentStats.ino !== visibleParentStats.ino || !visibleParentStats.isDirectory() || visibleParentStats.isSymbolicLink()) {
						throw new Error(`Refusing to access OMX plugin cache through a replaced namespace parent: ${actualParentPath}`);
					}
				}
				const openedChild = await open(childOpenPath, directoryOpenFlags(childOpenPath, directoryFlags, noFollowFlags));
				if (process.platform === "darwin") {
					const parentStats = await handles.at(-1)!.stat();
					const visibleParentStats = await lstat(actualParentPath);
					if (parentStats.dev !== visibleParentStats.dev || parentStats.ino !== visibleParentStats.ino || !visibleParentStats.isDirectory() || visibleParentStats.isSymbolicLink()) {
						await openedChild.close();
						throw new Error(`Refusing to access OMX plugin cache through a replaced namespace parent: ${actualParentPath}`);
					}
				}
				return openedChild;
			};
			let childHandle: FileHandle;
			try {
				childHandle = await openChild();
			} catch (error) {
				if (!isMissingPathError(error) || !options.create) {
					if (isMissingPathError(error) && !options.create) {
						for (const handle of handles.reverse()) await handle.close();
						return null;
					}
					const code = (error as NodeJS.ErrnoException).code;
					if (code === "ELOOP" || code === "ENOTDIR") {
						throw new Error(`Refusing to access OMX plugin cache through a symbolic link or non-directory namespace component: ${childPath}`);
					}
					throw error;
				}
				try {
					const parentStats = await handles.at(-1)!.stat();
					const visibleParentStats = await lstat(actualParentPath);
					if (parentStats.dev !== visibleParentStats.dev || parentStats.ino !== visibleParentStats.ino || !visibleParentStats.isDirectory() || visibleParentStats.isSymbolicLink()) {
						throw new Error(`Refusing to create OMX plugin cache through a replaced namespace parent: ${actualParentPath}`);
					}
					await mkdir(actualChildPath);
				} catch (mkdirError) {
					if ((mkdirError as NodeJS.ErrnoException).code !== "EEXIST") throw mkdirError;
				}
				try {
					childHandle = await openChild();
				} catch (retryError) {
					const code = (retryError as NodeJS.ErrnoException).code;
					if (code === "ELOOP" || code === "ENOTDIR") {
						throw new Error(`Refusing to access OMX plugin cache through a symbolic link or non-directory namespace component: ${childPath}`);
					}
					throw retryError;
				}
			}
			handles.push(childHandle);
			parentPath = process.platform === "darwin" ? actualChildPath : directoryFdPath(childHandle.fd);
			actualParentPath = actualChildPath;
			if (!parentPath) throw new Error("platform cannot expose an OMX plugin cache directory descriptor");
		}
		return { handle: handles.at(-1)!, fdPath: parentPath, handles };
	} catch (error) {
		for (const handle of handles.reverse()) {
			try { await handle.close(); } catch { /* preserve the primary failure */ }
		}
		throw error;
	}
}

async function inspectCacheRoot(cacheDir: string): Promise<"missing" | "directory" | "foreign" | "untrusted"> {
		try {
			const stats = await lstat(cacheDir);
			if (!stats.isDirectory() || stats.isSymbolicLink()) {
				return "untrusted";
			}
			if (!(await hasRegularPublicationMarker(cacheDir, ".omx-complete")) || await hasRegularPublicationMarker(cacheDir, ".omx-incomplete")) return "untrusted";
			const manifest = await readRegularOmxPluginCacheManifest(cacheDir);
			if (!manifest) {
				const manifestPath = join(cacheDir, ".codex-plugin", "plugin.json");
				try {
					const manifestStats = await lstat(manifestPath);
					if (manifestStats.isSymbolicLink()) return "directory";
				} catch {
					// Treat missing or unreadable manifests as foreign cache entries.
				}
			}
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
	let cacheRootIdentity: { dev: number; ino: number };
	try {
		const cacheRootStats = await lstat(cacheRoot);
		if (!cacheRootStats.isDirectory() || cacheRootStats.isSymbolicLink()) return [];
		if (typeof cacheRootStats.dev !== "number" || typeof cacheRootStats.ino !== "number") return [];
		cacheRootIdentity = { dev: cacheRootStats.dev, ino: cacheRootStats.ino };
	} catch {
		return [];
	}

	const queue: Array<{ path: string; depth: number }> = [
		{ path: cacheRoot, depth: 0 },
	];
	const maxDepth = 5;
	const matches: string[] = [];

	while (queue.length > 0) {
		const current = queue.shift();
		if (!current) break;
		if (current.depth >= 2) {
			if (await hasRegularPublicationMarker(current.path, ".omx-incomplete")) continue;
			const manifest = await readRegularOmxPluginCacheManifest(current.path, cacheRoot);
			if (manifest?.name === OMX_PLUGIN_NAME) {
				if (!(await hasRegularPublicationMarker(current.path, ".omx-complete"))) continue;
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

	try {
		const finalRootStats = await lstat(cacheRoot);
		if (!finalRootStats.isDirectory() || finalRootStats.isSymbolicLink() || finalRootStats.dev !== cacheRootIdentity.dev || finalRootStats.ino !== cacheRootIdentity.ino) return [];
	} catch {
		return [];
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

async function readRegularCacheSkillNames(cacheDir: string): Promise<string[] | null> {
	const skillsDir = join(cacheDir, "skills");
	try {
		const skillsStats = await lstat(skillsDir);
		if (!skillsStats.isDirectory() || skillsStats.isSymbolicLink()) return null;
		const entries = await readdir(skillsDir, { withFileTypes: true });
		if (entries.some((entry) => entry.isSymbolicLink() || !entry.isDirectory())) return null;
		for (const entry of entries) {
			const skillFile = join(skillsDir, entry.name, "SKILL.md");
			const skillStats = await lstat(skillFile);
			if (!skillStats.isFile() || skillStats.isSymbolicLink() || skillStats.nlink !== 1) return null;
			if (await readOmxPluginCacheFileNoFollow(skillFile, { anchorDir: cacheDir }) === null) return null;
		}
		return entries.map((entry) => entry.name).sort();
	} catch {
		return null;
	}
}

async function cacheCompanionIsReadable(cacheDir: string, relativePath: ".mcp.json" | ".app.json"): Promise<boolean> {
	const bytes = await readOmxPluginCacheFileNoFollow(join(cacheDir, relativePath), { anchorDir: cacheDir });
	if (bytes === null) return false;
	try {
		JSON.parse(bytes.toString("utf-8"));
		return true;
	} catch {
		return false;
	}
}

export async function readOmxPluginCacheState(
	cacheDir: string,
	expectedVersion?: string,
): Promise<OmxPluginCacheState | null> {
	// #3552: never read cache state through a symlinked or non-directory snapshot root —
	// readFile-based manifest reads would follow an external target before provenance checks.
	// A missing pinned launcher is reported by the dedicated launcher checks, not here.
	const executedAssetReason = await omxPluginCacheExecutedAssetProvenanceReason(cacheDir);
	if (executedAssetReason) return null;
	if (await hasRegularPublicationMarker(cacheDir, ".omx-incomplete")) return null;
	if (await omxPluginCacheManifestProvenanceReason(cacheDir, expectedVersion)) return null;
	const manifest = await readRegularOmxPluginCacheManifest(cacheDir);
	if (manifest?.name !== OMX_PLUGIN_NAME) return null;
	if (expectedVersion !== undefined && manifest.version !== expectedVersion) return null;
	const skillNames = await readRegularCacheSkillNames(cacheDir);
	if (!skillNames) return null;
	if (!(await cacheCompanionIsReadable(cacheDir, ".mcp.json")) || !(await cacheCompanionIsReadable(cacheDir, ".app.json"))) return null;
	const launcher = await readPinnedLauncherRaw(cacheDir);
	if (
		launcher.error ||
		!launcher.parsed ||
		typeof launcher.parsed.command !== "string" ||
		launcher.parsed.command.trim() === "" ||
		!Array.isArray(launcher.parsed.argsPrefix) ||
		launcher.parsed.argsPrefix.length !== 1 ||
		typeof launcher.parsed.argsPrefix[0] !== "string" ||
		launcher.parsed.argsPrefix[0].trim() === "" ||
		Object.keys(launcher.parsed).some((key) => key !== "command" && key !== "argsPrefix")
	) return null;
	return {
		cacheDir,
		manifestVersion:
			typeof manifest.version === "string" ? manifest.version : null,
		skillsPointer: typeof manifest.skills === "string" ? manifest.skills : null,
		skillNames,
		hooksPointer: typeof manifest.hooks === "string" ? manifest.hooks : null,
		mcpServersPointer: typeof manifest.mcpServers === "string" ? manifest.mcpServers : null,
		appsPointer: typeof manifest.apps === "string" ? manifest.apps : null,
		hookLauncherPinned: true,
	};
}

export async function hasExpectedOmxPluginCache(
	codexHomeDir: string,
	packagedMarketplace: PackagedOmxMarketplace,
	options: { teamMode?: SetupTeamMode; cacheDirOverride?: string } = {},
): Promise<boolean> {
	const [version, expectedSkillNames] = await Promise.all([
		packagedOmxPluginVersion(packagedMarketplace),
		expectedPackagedOmxSkillNames(packagedMarketplace, options),
	]);
	if (!version || !expectedSkillNames) return false;
	const state = await readOmxPluginCacheState(
		options.cacheDirOverride ?? join(omxPluginCacheBase(codexHomeDir), version),
		version,
	);
	if (!state) return false;
	if (
		state.manifestVersion !== version ||
		state.skillsPointer !== "./skills/" ||
		state.hooksPointer !== "./hooks/hooks.json" ||
		!state.hookLauncherPinned ||
		JSON.stringify(state.skillNames) !== JSON.stringify(expectedSkillNames)
	) {
		return false;
	}
	if (await omxPluginCacheProvenanceReason(state.cacheDir, packagedMarketplace, version, options)) {
		return false;
	}

	return pluginHookCacheMatchesPackaged(state.cacheDir, packagedMarketplace);
}

async function fileContentsEqual(leftPath: string, rightPath: string, anchorDir?: string): Promise<boolean> {
	const [left, right] = await Promise.all([
		readOmxPluginCacheFileNoFollow(leftPath, anchorDir ? { anchorDir } : {}),
		readOmxPluginCacheFileNoFollow(rightPath, { requireSingleLink: false }),
	]);
	return left !== null && right !== null && left.equals(right);
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
		cacheDir,
	) && await fileContentsEqual(
		join(cacheDir, "hooks", "codex-native-hook.mjs"),
		join(packagedMarketplace.pluginRoot, "hooks", "codex-native-hook.mjs"),
		cacheDir,
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
	return await readRegularFileTextNoFollow(
		join(cacheDir, "hooks", OMX_PLUGIN_HOOK_LAUNCHER_FILE),
		{ anchorDir: cacheDir },
	) === buildPinnedHookLauncherContent(packagedMarketplace);
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
	const raw = await readRegularFileTextNoFollow(launcherPath, { anchorDir: cacheDir });
	if (raw === null) {
		try {
			await lstat(launcherPath);
			return { raw: null, parsed: null, error: "cannot read pinned launcher" };
		} catch (e) {
			if (isMissingPathError(e)) return { raw: null, parsed: null, error: "missing pinned launcher" };
			return { raw: null, parsed: null, error: `cannot read pinned launcher: ${(e as Error).message}` };
		}
	}
	try {
		const parsed = JSON.parse(raw) as { command?: unknown; argsPrefix?: unknown };
		if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
			return { raw, parsed: null, error: `malformed pinned launcher JSON: expected object but got ${Array.isArray(parsed) ? "array" : String(parsed)}` };
		}
		return { raw, parsed, error: undefined };
	} catch (e) {
		return { raw, parsed: null, error: `malformed pinned launcher JSON: ${(e as Error).message}` };
	}
}

export async function getPinnedLauncherIncompatibilityReason(
	cacheDir: string,
	packagedMarketplace: PackagedOmxMarketplace,
): Promise<{ reason: string; target?: string } | null> {
	const hooksDir = join(cacheDir, "hooks");
	try {
		const hooksStats = await lstat(hooksDir);
		if (!hooksStats.isDirectory() || hooksStats.isSymbolicLink()) {
			return { reason: `hooks directory at ${hooksDir} is a symlink or not a directory; run ${PLUGIN_LAUNCHER_RECOVERY_HINT} then rerun omx setup --plugin` };
		}
	} catch (e) {
		if (isMissingPathError(e)) return { reason: `hooks directory missing at ${hooksDir}; run ${PLUGIN_LAUNCHER_RECOVERY_HINT} then rerun omx setup --plugin` };
		return { reason: `cannot read hooks directory at ${hooksDir}: ${(e as Error).message}; run ${PLUGIN_LAUNCHER_RECOVERY_HINT} then rerun omx setup --plugin` };
	}
	const launcherPath = join(cacheDir, "hooks", OMX_PLUGIN_HOOK_LAUNCHER_FILE);
	try {
		const launcherStats = await lstat(launcherPath);
		if (!launcherStats.isFile() || launcherStats.isSymbolicLink() || launcherStats.nlink !== 1) {
			return { reason: `pinned launcher at ${launcherPath} is a symlink or not a regular file; run ${PLUGIN_LAUNCHER_RECOVERY_HINT} then rerun omx setup --plugin` };
		}
	} catch (e) {
		if (isMissingPathError(e)) return { reason: `pinned launcher missing at ${launcherPath}; run ${PLUGIN_LAUNCHER_RECOVERY_HINT} then rerun omx setup --plugin` };
		return { reason: `cannot read pinned launcher at ${launcherPath}: ${(e as Error).message}; run ${PLUGIN_LAUNCHER_RECOVERY_HINT} then rerun omx setup --plugin` };
	}
	const raw = await readRegularFileTextNoFollow(launcherPath, { anchorDir: cacheDir });
	if (raw === null) {
		try {
			await lstat(launcherPath);
			return { reason: `cannot read pinned launcher at ${launcherPath}; run ${PLUGIN_LAUNCHER_RECOVERY_HINT} then rerun omx setup --plugin` };
		} catch (e) {
			if (isMissingPathError(e)) return { reason: `pinned launcher missing at ${launcherPath}; run ${PLUGIN_LAUNCHER_RECOVERY_HINT} then rerun omx setup --plugin` };
			return { reason: `cannot read pinned launcher at ${launcherPath}: ${(e as Error).message}; run ${PLUGIN_LAUNCHER_RECOVERY_HINT} then rerun omx setup --plugin` };
		}
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
	anchoredCacheBasePath?: string,
): Promise<string[]> {
	const cacheBase = omxPluginCacheBase(codexHomeDir);
	const managedBase = anchoredCacheBasePath ?? cacheBase;
	const noFollowFlags = fsConstants.O_NOFOLLOW;
	const directoryFlags = fsConstants.O_DIRECTORY;
	if (typeof noFollowFlags !== "number" || typeof directoryFlags !== "number") {
		throw new Error("platform cannot provide no-follow directory anchoring for cache retirement");
	}
	let baseHandle: FileHandle | undefined;
	const candidateHandles: FileHandle[] = [];
	try {
		baseHandle = await open(managedBase, directoryOpenFlags(managedBase, directoryFlags, noFollowFlags));
		const baseFdPath = directoryFdPath(baseHandle.fd);
		if (!baseFdPath) throw new Error("platform cannot expose an anchored cache directory descriptor for cache retirement");
		const entries = await readdir(baseFdPath, { withFileTypes: true });
		const managed: Array<{ path: string; managedPath: string; version: string; mtimeMs: number; handle: FileHandle; stats: Stats }> = [];
		for (const entry of entries) {
			if (!entry.isDirectory() || entry.name === currentVersion) continue;
			const path = join(baseFdPath, entry.name);
			let candidateHandle: FileHandle;
			try {
				candidateHandle = await open(path, fsConstants.O_RDONLY | directoryFlags | noFollowFlags);
			} catch {
				continue;
			}
			const candidateStats = await candidateHandle.stat();
			if (!candidateStats.isDirectory() || candidateStats.isSymbolicLink()) {
				await candidateHandle.close();
				continue;
			}
			candidateHandles.push(candidateHandle);
			const candidateFdPath = directoryFdPath(candidateHandle.fd);
			if (!candidateFdPath) continue;
			const manifest = await readRegularOmxPluginCacheManifest(candidateFdPath, candidateFdPath);
			if (manifest?.name !== OMX_PLUGIN_NAME || manifest.version !== entry.name) continue;
			if (!(await hasRegularPublicationMarker(candidateFdPath, ".omx-complete")) || await hasRegularPublicationMarker(candidateFdPath, ".omx-incomplete")) continue;
			if (await readOmxPluginCacheFileNoFollow(join(candidateFdPath, ".omx-live-pin"), { anchorDir: candidateFdPath }) !== null) continue;
			managed.push({ path: join(cacheBase, entry.name), managedPath: path, version: entry.name, mtimeMs: candidateStats.mtimeMs, handle: candidateHandle, stats: candidateStats });
		}
		managed.sort((left, right) =>
			right.version.localeCompare(left.version, undefined, { numeric: true }) ||
			right.mtimeMs - left.mtimeMs,
		);
		const retired: string[] = [];
		for (const candidate of managed.slice(1)) {
			const currentStats = await lstat(candidate.managedPath);
			if (!currentStats.isDirectory() || currentStats.isSymbolicLink() || currentStats.dev !== candidate.stats.dev || currentStats.ino !== candidate.stats.ino) {
				throw new Error(`managed cache retirement target changed before removal: ${candidate.path}`);
			}
			await rm(candidate.managedPath, { recursive: true, force: true });
			retired.push(candidate.path);
		}
		return retired;
	} finally {
		for (const candidateHandle of candidateHandles.reverse()) await candidateHandle.close();
		if (baseHandle) await baseHandle.close();
	}
}

interface MaterializePackagedOmxPluginCacheOptions {
	dryRun?: boolean;
	teamMode?: SetupTeamMode;
	onCacheDirPrepared?: (cacheDir: string) => void | Promise<void>;
	anchoredCacheBasePath?: string;
	anchoredCacheDir?: string;
	cacheDirOverride?: string;
}

async function materializePackagedOmxPluginCacheImpl(
	codexHomeDir: string,
	packagedMarketplace: PackagedOmxMarketplace | null,
	options: MaterializePackagedOmxPluginCacheOptions = {},
): Promise<OmxPluginCacheMaterializeResult> {
	if (!packagedMarketplace) return { status: "unavailable" };
	const version = await packagedOmxPluginVersion(packagedMarketplace);
	if (!version) return { status: "unavailable" };
	const cacheDir = join(omxPluginCacheBase(codexHomeDir), version);
	const inspectedCacheDir = options.anchoredCacheDir ?? cacheDir;
	if (await hasExpectedOmxPluginCache(codexHomeDir, packagedMarketplace, {
		...options,
		cacheDirOverride: inspectedCacheDir,
	})) {
		return {
			status: "unchanged",
			cacheDir,
			version,
			retiredDirs: options.dryRun
				? []
				: await retireUnpinnedManagedSnapshots(codexHomeDir, version, options.anchoredCacheBasePath),
		};
	}
	// Same-version directory exists but is not byte-identical: distinguish immutable-preserved vs dead/provenance-incompatible launcher.
	// Preserve #3499 immutability: never rewrite an existing same-version directory in place.
	const rootState = await inspectCacheRoot(inspectedCacheDir);
	if (rootState === "untrusted") {
		return {
			status: "stale-launcher",
			cacheDir,
			version,
			reason: `OMX plugin cache root at ${cacheDir} is a symlink or non-directory entry; managed snapshots must be regular immutable directories; run ${PLUGIN_LAUNCHER_RECOVERY_HINT} then rerun omx setup --plugin`,
			launcherTarget: undefined,
			retiredDirs: options.dryRun ? [] : await retireUnpinnedManagedSnapshots(codexHomeDir, version, options.anchoredCacheBasePath),
		};
	}
	if (rootState === "directory") {
		const incompat = await getPinnedLauncherIncompatibilityReason(inspectedCacheDir, packagedMarketplace);
		if (incompat) {
			return {
				status: "stale-launcher",
				cacheDir,
				version,
				reason: incompat.reason,
				launcherTarget: incompat.target,
				retiredDirs: options.dryRun ? [] : await retireUnpinnedManagedSnapshots(codexHomeDir, version, options.anchoredCacheBasePath),
			};
		}
		const snapshotProvenanceReason = await omxPluginCacheProvenanceReason(
			inspectedCacheDir,
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
				retiredDirs: options.dryRun ? [] : await retireUnpinnedManagedSnapshots(codexHomeDir, version, options.anchoredCacheBasePath),
			};
		}
		const assetProvenanceReason = await omxPluginCacheExecutedAssetProvenanceReason(inspectedCacheDir);
		if (assetProvenanceReason) {
			return {
				status: "stale-launcher",
				cacheDir,
				version,
				reason: `${assetProvenanceReason}; run ${PLUGIN_LAUNCHER_RECOVERY_HINT} then rerun omx setup --plugin`,
				launcherTarget: undefined,
				retiredDirs: options.dryRun ? [] : await retireUnpinnedManagedSnapshots(codexHomeDir, version, options.anchoredCacheBasePath),
			};
		}
		return {
			status: "unchanged",
			cacheDir,
			version,
			retiredDirs: options.dryRun ? [] : await retireUnpinnedManagedSnapshots(codexHomeDir, version, options.anchoredCacheBasePath),
		};
	}
	if (rootState === "foreign") {
		return { status: "unavailable", cacheDir, version };
	}
	if (!options.dryRun) {
		const cacheBase = omxPluginCacheBase(codexHomeDir);
		const noFollowFlags = fsConstants.O_NOFOLLOW;
		const directoryFlags = fsConstants.O_DIRECTORY;
		if (typeof noFollowFlags !== "number" || typeof directoryFlags !== "number") {
			return {
				status: "stale-launcher",
				cacheDir,
				version,
				reason: "platform cannot provide no-follow directory anchoring for immutable cache publication",
				launcherTarget: undefined,
				retiredDirs: [],
			};
		}
		let cacheBaseHandle;
		let cacheBaseFdPath: string | null | undefined = options.anchoredCacheBasePath;
		if (!cacheBaseFdPath) {
			cacheBaseHandle = await open(cacheBase, fsConstants.O_RDONLY | directoryFlags | noFollowFlags);
			cacheBaseFdPath = directoryFdPath(cacheBaseHandle.fd);
		}
		if (!cacheBaseFdPath) {
			if (cacheBaseHandle) await cacheBaseHandle.close();
			return {
				status: "stale-launcher",
				cacheDir,
				version,
				reason: "platform cannot expose an anchored cache directory descriptor for immutable publication",
				launcherTarget: undefined,
				retiredDirs: [],
			};
		}
		const lockPath = join(cacheBaseFdPath, ".omx-publish.lock");
		let lockHandle: FileHandle;
		try {
			lockHandle = await claimPublicationLock(cacheBaseFdPath, cacheBase, noFollowFlags);
		} catch (error) {
			if (cacheBaseHandle) await cacheBaseHandle.close();
			return {
				status: "stale-launcher",
				cacheDir,
				version,
				reason: `cannot claim immutable OMX plugin cache publication at ${cacheBase}: ${(error as Error).message}`,
				launcherTarget: undefined,
				retiredDirs: [],
			};
		}
		let tempDir: string | undefined;
		let outcome: OmxPluginCacheMaterializeResult = {
			status: "materialized",
			cacheDir,
			version,
			retiredDirs: [],
		};
		let cleanupError: unknown = null;
		let lockIdentity: Stats | undefined;
		let finalHandle: FileHandle | undefined;
		try {
			lockIdentity = await lockHandle.stat();
			tempDir = await mkdtemp(join(cacheBaseFdPath, `.omx-plugin-${version}-`));
			const snapshotDir = await stageCompletePluginSnapshot(
				tempDir,
				packagedMarketplace,
				version,
				options.teamMode,
			);
			await syncDirectoryTree(snapshotDir);
			const finalPath = join(cacheBaseFdPath, version);
			await options.onCacheDirPrepared?.(cacheDir);
			try {
				await mkdir(finalPath);
				finalHandle = await open(finalPath, fsConstants.O_RDONLY | directoryFlags | noFollowFlags);
				const finalFdPath = directoryFdPath(finalHandle.fd);
				if (!finalFdPath) throw new Error("platform cannot expose an anchored publication directory descriptor");
				await writeFile(join(finalFdPath, ".omx-incomplete"), `${process.pid}\n`);
				await syncRegularFile(join(finalFdPath, ".omx-incomplete"));
				const stagedEntries = await readdir(snapshotDir, { withFileTypes: true });
				for (const entry of stagedEntries) {
					if (entry.isSymbolicLink()) throw new Error(`refusing to publish symlinked cache entry: ${entry.name}`);
					await rename(join(snapshotDir, entry.name), join(finalFdPath, entry.name));
				}
				await syncDirectoryTree(finalFdPath, finalHandle);
				await writeFile(join(finalFdPath, ".omx-complete"), `${process.pid}\n`);
				await syncRegularFile(join(finalFdPath, ".omx-complete"));
				await rm(join(finalFdPath, ".omx-incomplete"), { force: true });
				await syncDirectory(finalFdPath);
				const finalPathStats = await lstat(finalPath);
				const finalDescriptorStats = await finalHandle.stat();
				if (!finalPathStats.isDirectory() || finalPathStats.isSymbolicLink() || finalPathStats.dev !== finalDescriptorStats.dev || finalPathStats.ino !== finalDescriptorStats.ino) {
					throw new Error(`published cache directory changed before validation: ${cacheDir}`);
				}
				if (!options.anchoredCacheBasePath) await syncDirectory(cacheBase);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === "EEXIST") {
					outcome = {
						status: "stale-launcher",
						cacheDir,
						version,
						reason: `same-version OMX plugin cache appeared concurrently at ${cacheDir}; refusing to replace an immutable cache`,
						launcherTarget: undefined,
						retiredDirs: [],
					};
				} else {
					throw error;
				}
			}
		} catch (error) {
			outcome = {
				status: "stale-launcher",
				cacheDir,
				version,
				reason: `immutable OMX plugin cache publication failed closed: ${(error as Error).message}`,
				launcherTarget: undefined,
				retiredDirs: [],
			};
		} finally {
			try {
				if (finalHandle) await finalHandle.close();
			} catch (error) {
				cleanupError ??= error;
			}
			try {
				if (tempDir) await rm(tempDir, { recursive: true, force: true });
			} catch (error) {
				cleanupError = error;
			}
			try {
				await lockHandle.close();
			} catch (error) {
				cleanupError ??= error;
			}
			try {
				if (!lockIdentity) throw new Error(`publication lock identity unavailable at ${cacheBase}`);
				const currentLockStats = await lstat(lockPath);
				if (currentLockStats.dev !== lockIdentity.dev || currentLockStats.ino !== lockIdentity.ino) {
					throw new Error(`publication lock changed before cleanup at ${cacheBase}`);
				}
				await rm(lockPath, { force: true });
				if (!options.anchoredCacheBasePath) await syncDirectory(cacheBase);
			} catch (error) {
				cleanupError ??= error;
			}
			if (cacheBaseHandle) {
				try {
					await cacheBaseHandle.close();
				} catch (error) {
					cleanupError ??= error;
				}
			}
		}
		if (cleanupError) {
			return {
				status: "stale-launcher",
				cacheDir,
				version,
				reason: `immutable OMX plugin cache publication cleanup failed closed: ${(cleanupError as Error).message}`,
				launcherTarget: undefined,
				retiredDirs: [],
			};
		}
		if (outcome.status === "materialized" && !options.dryRun) {
			try {
				outcome.retiredDirs = await retireUnpinnedManagedSnapshots(
					codexHomeDir,
					version,
					options.anchoredCacheBasePath,
				);
			} catch (error) {
				return {
					status: "stale-launcher",
					cacheDir,
					version,
					reason: `immutable OMX plugin cache retirement failed closed: ${(error as Error).message}`,
					launcherTarget: undefined,
					retiredDirs: [],
				};
			}
		}
		return outcome;
	}
	return {
		status: "materialized",
		cacheDir,
		version,
		retiredDirs: options.dryRun
			? []
			: await retireUnpinnedManagedSnapshots(codexHomeDir, version, options.anchoredCacheBasePath),
	};
}

export async function materializePackagedOmxPluginCache(
	codexHomeDir: string,
	packagedMarketplace: PackagedOmxMarketplace | null,
	options: MaterializePackagedOmxPluginCacheOptions = {},
): Promise<OmxPluginCacheMaterializeResult> {
	if (!packagedMarketplace) return { status: "unavailable" };
	const version = await packagedOmxPluginVersion(packagedMarketplace);
	if (!version) return { status: "unavailable" };
	const cacheBase = omxPluginCacheBase(codexHomeDir);
	const cacheDir = join(cacheBase, version);
	const noFollowFlags = fsConstants.O_NOFOLLOW;
	const directoryFlags = fsConstants.O_DIRECTORY;
	if (typeof noFollowFlags !== "number" || typeof directoryFlags !== "number") {
		return {
			status: "stale-launcher",
			cacheDir,
			version,
			reason: "platform cannot provide no-follow directory anchoring for immutable cache validation/publication",
			launcherTarget: undefined,
			retiredDirs: [],
		};
	}
	let namespace: { handle: FileHandle; fdPath: string; handles: FileHandle[] } | null;
	try {
		namespace = await openManagedCacheNamespace(cacheBase, codexHomeDir, { create: !options.dryRun });
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "EINVAL" || code === "ENOTSUP" || code === "EOPNOTSUPP") {
			return {
				status: "stale-launcher",
				cacheDir,
				version,
				reason: `cannot anchor OMX plugin cache namespace at ${cacheBase}: ${code}; refusing to trust or publish cache contents`,
				launcherTarget: undefined,
				retiredDirs: [],
			};
		}
		throw error;
	}
	if (!namespace) {
		return { status: "materialized", cacheDir, version, retiredDirs: [] };
	}
	const cacheBaseFdPath = namespace.fdPath;
	let result: OmxPluginCacheMaterializeResult;
	try {
		result = await materializePackagedOmxPluginCacheImpl(
			codexHomeDir,
			packagedMarketplace,
			{
				...options,
				anchoredCacheBasePath: cacheBaseFdPath,
				anchoredCacheDir: join(cacheBaseFdPath, version),
			},
		);
	} catch (error) {
		result = {
			status: "stale-launcher",
			cacheDir,
			version,
			reason: `anchored OMX plugin cache operation failed closed: ${(error as Error).message}`,
			launcherTarget: undefined,
			retiredDirs: [],
		};
	}
	let closeError: unknown = null;
	for (const handle of namespace.handles.reverse()) {
		try {
			await handle.close();
		} catch (error) {
			closeError ??= error;
		}
	}
	if (closeError) {
		return {
			status: "stale-launcher",
			cacheDir,
			version,
			reason: `anchored OMX plugin cache descriptor close failed closed: ${(closeError as Error).message}`,
			launcherTarget: undefined,
			retiredDirs: [],
		};
	}
	return result;
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
