import { constants as fsConstants, existsSync, type Stats } from "fs";
import { randomUUID } from "crypto";
import { lstat, mkdir, mkdtemp, open, readdir, readFile, realpath, rename, rm, type FileHandle } from "fs/promises";
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
	return null;
}

function isDirectoryDescriptorPath(path: string): boolean {
	return /^\/proc\/self\/fd\/\d+$/.test(path);
}

function directoryOpenFlags(path: string, directoryFlags: number, noFollowFlags: number): number {
	return fsConstants.O_RDONLY | directoryFlags | (isDirectoryDescriptorPath(path) ? 0 : noFollowFlags);
}

interface DirectoryRef {
	handle: FileHandle;
	path: string;
	operationPath: string;
}

function directoryOperationPath(handle: FileHandle, path: string): string | null {
	return directoryFdPath(handle.fd) ?? resolve(path);
}

function childOperationPath(parent: DirectoryRef, name: string): string {
	if (!name || name === "." || name === ".." || name.includes("/") || name.includes("\\")) {
		throw new Error(`invalid descriptor-relative child name: ${name}`);
	}
	return join(parent.operationPath, name);
}

async function assertDirectoryRef(parent: DirectoryRef, operation: string): Promise<void> {
	const descriptorStats = await parent.handle.stat();
	const visibleStats = await lstat(parent.path);
	if (
		!descriptorStats.isDirectory() ||
		!visibleStats.isDirectory() ||
		visibleStats.isSymbolicLink() ||
		descriptorStats.dev !== visibleStats.dev ||
		descriptorStats.ino !== visibleStats.ino
	) {
		throw new Error(`descriptor-bound ${operation} parent was replaced: ${parent.path}`);
	}
}

async function openDirectoryRef(path: string): Promise<DirectoryRef> {
	const noFollowFlags = fsConstants.O_NOFOLLOW;
	const directoryFlags = fsConstants.O_DIRECTORY;
	if (typeof noFollowFlags !== "number" || typeof directoryFlags !== "number") {
		throw new Error("directory anchoring flags are unavailable");
	}
	const visiblePath = resolve(path);
	const handle = await open(visiblePath, directoryOpenFlags(visiblePath, directoryFlags, noFollowFlags));
	const operationPath = directoryOperationPath(handle, visiblePath);
	if (!operationPath) {
		await handle.close();
		throw new Error("platform cannot expose a descriptor-relative directory operation path");
	}
	const ref = { handle, path: visiblePath, operationPath };
	try {
		await assertDirectoryRef(ref, "open");
		return ref;
	} catch (error) {
		await handle.close();
		throw error;
	}
}

async function openDirectoryChild(parent: DirectoryRef, name: string): Promise<DirectoryRef> {
	const noFollowFlags = fsConstants.O_NOFOLLOW;
	const directoryFlags = fsConstants.O_DIRECTORY;
	if (typeof noFollowFlags !== "number" || typeof directoryFlags !== "number") {
		throw new Error("directory anchoring flags are unavailable");
	}
	const operationPath = childOperationPath(parent, name);
	const visiblePath = join(parent.path, name);
	await assertDirectoryRef(parent, "open");
	const handle = await open(operationPath, directoryOpenFlags(operationPath, directoryFlags, noFollowFlags));
	const childOperation = directoryOperationPath(handle, visiblePath);
	if (!childOperation) {
		await handle.close();
		throw new Error("platform cannot expose a descriptor-relative directory operation path");
	}
	const child = { handle, path: visiblePath, operationPath: childOperation };
	try {
		await assertDirectoryRef(parent, "open");
		await assertDirectoryRef(child, "open");
		return child;
	} catch (error) {
		await handle.close();
		throw error;
	}
}

async function mkdirDirectoryChild(parent: DirectoryRef, name: string): Promise<void> {
	const operationPath = childOperationPath(parent, name);
	await assertDirectoryRef(parent, "mkdir");
	try {
		await mkdir(operationPath);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
	}
	await assertDirectoryRef(parent, "mkdir");
}

async function mkdirDirectoryChildExclusive(parent: DirectoryRef, name: string): Promise<void> {
	const operationPath = childOperationPath(parent, name);
	await assertDirectoryRef(parent, "exclusive mkdir");
	await mkdir(operationPath);
	await assertDirectoryRef(parent, "exclusive mkdir");
}

async function copyPackagedTree(sourcePath: string, destination: DirectoryRef): Promise<void> {
	const sourceStats = await lstat(sourcePath);
	if (!sourceStats.isDirectory() || sourceStats.isSymbolicLink()) {
		throw new Error(`refusing to copy a non-directory packaged plugin root: ${sourcePath}`);
	}
	const entries = await readdir(sourcePath, { withFileTypes: true });
	for (const entry of entries) {
		const sourceChildPath = join(sourcePath, entry.name);
		if (entry.isSymbolicLink()) {
			throw new Error(`refusing to copy a symlinked packaged plugin entry: ${sourceChildPath}`);
		}
		if (entry.isDirectory()) {
			await mkdirDirectoryChildExclusive(destination, entry.name);
			const child = await openDirectoryChild(destination, entry.name);
			try {
				await copyPackagedTree(sourceChildPath, child);
			} finally {
				await child.handle.close();
			}
			continue;
		}
		if (!entry.isFile()) {
			throw new Error(`refusing to copy a non-regular packaged plugin entry: ${sourceChildPath}`);
		}
		const sourceHandle = await open(sourceChildPath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
		try {
			const before = await sourceHandle.stat();
			if (!before.isFile() || before.isSymbolicLink()) {
				throw new Error(`packaged plugin entry changed while copying: ${sourceChildPath}`);
			}
			const content = await sourceHandle.readFile();
			const after = await sourceHandle.stat();
			if (
				after.dev !== before.dev ||
				after.ino !== before.ino ||
				after.size !== before.size
			) {
				throw new Error(`packaged plugin entry changed while copying: ${sourceChildPath}`);
			}
			const destinationHandle = await openRegularFileChild(
				destination,
				entry.name,
				fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW,
				before.mode & 0o7777,
			);
			try {
				await destinationHandle.writeFile(content);
				await destinationHandle.chmod(before.mode & 0o7777);
				await destinationHandle.sync();
			} finally {
				await destinationHandle.close();
			}
		} finally {
			await sourceHandle.close();
		}
	}
}

async function openRegularFileChild(parent: DirectoryRef, name: string, flags: number, mode?: number): Promise<FileHandle> {
	const operationPath = childOperationPath(parent, name);
	await assertDirectoryRef(parent, "file open");
	const handle = await open(operationPath, flags, mode);
	try {
		await assertDirectoryRef(parent, "file open");
		return handle;
	} catch (error) {
		await handle.close();
		throw error;
	}
}

async function syncRegularFileChild(parent: DirectoryRef, name: string): Promise<void> {
	const noFollowFlags = fsConstants.O_NOFOLLOW;
	if (typeof noFollowFlags !== "number") throw new Error("O_NOFOLLOW is unavailable");
	const handle = await openRegularFileChild(parent, name, fsConstants.O_RDONLY | noFollowFlags);
	try {
		await handle.sync();
	} finally {
		await handle.close();
	}
	await assertDirectoryRef(parent, "file sync");
}

async function writeRegularFileChild(parent: DirectoryRef, name: string, content: string): Promise<void> {
	const noFollowFlags = fsConstants.O_NOFOLLOW;
	if (typeof noFollowFlags !== "number") throw new Error("O_NOFOLLOW is unavailable");
	const handle = await openRegularFileChild(parent, name, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_TRUNC | noFollowFlags, 0o600);
	try {
		await handle.writeFile(content);
		await handle.sync();
	} finally {
		await handle.close();
	}
	await assertDirectoryRef(parent, "file write");
}

async function createExclusiveFileChild(parent: DirectoryRef, name: string, content: string): Promise<void> {
	const noFollowFlags = fsConstants.O_NOFOLLOW;
	if (typeof noFollowFlags !== "number") throw new Error("O_NOFOLLOW is unavailable");
	const handle = await openRegularFileChild(parent, name, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | noFollowFlags, 0o600);
	try {
		await handle.writeFile(content);
		await handle.sync();
	} finally {
		await handle.close();
	}
	await assertDirectoryRef(parent, "exclusive file create");
}

async function removeChild(parent: DirectoryRef, name: string, options: { recursive?: boolean; force?: boolean } = {}): Promise<void> {
	const operationPath = childOperationPath(parent, name);
	await assertDirectoryRef(parent, "remove");
	await rm(operationPath, options);
	await assertDirectoryRef(parent, "remove");
}

async function renameChild(sourceParent: DirectoryRef, sourceName: string, destinationParent: DirectoryRef, destinationName: string): Promise<void> {
	const sourcePath = childOperationPath(sourceParent, sourceName);
	const destinationPath = childOperationPath(destinationParent, destinationName);
	await assertDirectoryRef(sourceParent, "rename");
	await assertDirectoryRef(destinationParent, "rename");
	await rename(sourcePath, destinationPath);
	await assertDirectoryRef(sourceParent, "rename");
	await assertDirectoryRef(destinationParent, "rename");
}

async function syncDirectoryTree(directory: DirectoryRef): Promise<void> {
	await assertDirectoryRef(directory, "directory sync");
	const entries = await readdir(directory.operationPath, { withFileTypes: true });
	for (const entry of entries) {
		if (entry.isSymbolicLink()) throw new Error(`cannot sync symlinked cache entry: ${join(directory.path, entry.name)}`);
		if (entry.isDirectory()) {
			const child = await openDirectoryChild(directory, entry.name);
			try {
				await syncDirectoryTree(child);
			} finally {
				await child.handle.close();
			}
		} else {
			await syncRegularFileChild(directory, entry.name);
		}
	}
	await assertDirectoryRef(directory, "directory sync");
	await directory.handle.sync();
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

async function reclaimStalePublicationLock(
	cacheBaseRef: DirectoryRef,
	lockName: string,
	lockStats: Stats,
): Promise<void> {
	const quarantineName = `${lockName}.reclaim-${process.pid}-${randomUUID()}`;
	await renameChild(cacheBaseRef, lockName, cacheBaseRef, quarantineName);
	const quarantinePath = childOperationPath(cacheBaseRef, quarantineName);
	let quarantineStats: Stats;
	try {
		quarantineStats = await lstat(quarantinePath);
	} catch (error) {
		throw new Error(`stale publication lock disappeared during reclamation: ${(error as Error).message}`);
	}
	if (quarantineStats.dev !== lockStats.dev || quarantineStats.ino !== lockStats.ino) {
		try {
			await renameChild(cacheBaseRef, quarantineName, cacheBaseRef, lockName);
		} catch {
			// Preserve a replacement lock if another publisher claimed the name.
		}
		throw new Error("publication lock changed during stale-lock reclamation");
	}
	await removeChild(cacheBaseRef, quarantineName, { force: true });
}

async function claimPublicationLock(
	cacheBaseRef: DirectoryRef,
	cacheBase: string,
	noFollowFlags: number,
): Promise<FileHandle> {
	for (let attempt = 0; attempt < 2; attempt += 1) {
		try {
			const lockHandle = await openRegularFileChild(
				cacheBaseRef,
				".omx-publish.lock",
				fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | noFollowFlags,
				0o600,
			);
			try {
				await lockHandle.writeFile(`${JSON.stringify({ pid: process.pid, createdAt: Date.now() })}\n`);
				await lockHandle.sync();
			} catch (error) {
				try { await lockHandle.close(); } catch { /* preserve the primary failure */ }
				try { await removeChild(cacheBaseRef, ".omx-publish.lock", { force: true }); } catch { /* preserve the primary failure */ }
				throw error;
			}
			return lockHandle;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST" || attempt > 0) throw error;
			const lockPath = join(cacheBaseRef.path, ".omx-publish.lock");
			let lockBefore: Stats;
			try { lockBefore = await lstat(lockPath); } catch { continue; }
			if (!lockBefore.isFile() || lockBefore.isSymbolicLink() || typeof lockBefore.dev !== "number" || typeof lockBefore.ino !== "number") {
				throw new Error(`another OMX plugin cache publication is active at ${cacheBase}; refusing concurrent publication`);
			}
			const lockBytes = await readOmxPluginCacheFileNoFollow(lockPath, { anchorDir: cacheBaseRef.path });
			let lockAfter: Stats;
			try { lockAfter = await lstat(lockPath); } catch { continue; }
			if (lockAfter.dev !== lockBefore.dev || lockAfter.ino !== lockBefore.ino) continue;
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
			const reclaimBefore = await lstat(lockPath);
			if (reclaimBefore.dev !== lockBefore.dev || reclaimBefore.ino !== lockBefore.ino) continue;
			try {
				await reclaimStalePublicationLock(cacheBaseRef, ".omx-publish.lock", reclaimBefore);
			} catch (reclaimError) {
				if ((reclaimError as NodeJS.ErrnoException).code === "ENOENT") continue;
				if ((reclaimError as Error).message === "publication lock changed during stale-lock reclamation") continue;
				throw reclaimError;
			}
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
): Promise<{ handle: FileHandle; fdPath: string; path: string; handles: FileHandle[] } | null> {
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
		const homeRef = await openDirectoryRef(homeRealpath);
		handles.push(homeRef.handle);
		let parentRef = homeRef;
		for (const component of managedNamespace.split(sep).filter(Boolean)) {
			let childRef: DirectoryRef;
			try {
				childRef = await openDirectoryChild(parentRef, component);
			} catch (error) {
				if (!isMissingPathError(error) || !options.create) {
					if (isMissingPathError(error) && !options.create) {
						for (const handle of handles.reverse()) await handle.close();
						return null;
					}
					const code = (error as NodeJS.ErrnoException).code;
					if (code === "ELOOP" || code === "ENOTDIR") {
						throw new Error(`Refusing to access OMX plugin cache through a symbolic link or non-directory namespace component: ${join(parentRef.path, component)}`);
					}
					throw error;
				}
				try {
					await mkdirDirectoryChild(parentRef, component);
				} catch (mkdirError) {
					if ((mkdirError as NodeJS.ErrnoException).code !== "EEXIST") throw mkdirError;
				}
				try {
					childRef = await openDirectoryChild(parentRef, component);
				} catch (retryError) {
					const code = (retryError as NodeJS.ErrnoException).code;
					if (code === "ELOOP" || code === "ENOTDIR") {
						throw new Error(`Refusing to access OMX plugin cache through a symbolic link or non-directory namespace component: ${join(parentRef.path, component)}`);
					}
					throw retryError;
				}
			}
			handles.push(childRef.handle);
			parentRef = childRef;
		}
		return { handle: parentRef.handle, fdPath: parentRef.operationPath, path: parentRef.path, handles };
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
	stagingParent: DirectoryRef,
	packagedMarketplace: PackagedOmxMarketplace,
	version: string,
	teamMode: SetupTeamMode | undefined,
): Promise<DirectoryRef> {
	await assertDirectoryRef(stagingParent, "snapshot staging");
	await mkdirDirectoryChildExclusive(stagingParent, "snapshot");
	const snapshot = await openDirectoryChild(stagingParent, "snapshot");
	try {
		await createExclusiveFileChild(snapshot, ".omx-incomplete", `${process.pid}\n`);
		await copyPackagedTree(packagedMarketplace.pluginRoot, snapshot);
		await assertDirectoryRef(snapshot, "snapshot staging");
		await applyTeamModeToPluginCache(snapshot, teamMode);
		const hooksDir = await openDirectoryChild(snapshot, "hooks");
		try {
			await writePinnedHookLauncher(hooksDir, packagedMarketplace);
		} finally {
			await hooksDir.handle.close();
		}
		const manifest = await readRegularOmxPluginCacheManifest(snapshot.operationPath, snapshot.operationPath);
		const skillsDir = await openDirectoryChild(snapshot, "skills");
		await skillsDir.handle.close();
		if (
			manifest?.name !== OMX_PLUGIN_NAME ||
			manifest.version !== version ||
			manifest.skills !== "./skills/" ||
			manifest.hooks !== "./hooks/hooks.json"
		) {
			throw new Error(`Packaged OMX plugin snapshot is incomplete or has invalid provenance: ${snapshot.path}`);
		}
		return snapshot;
	} catch (error) {
		await snapshot.handle.close();
		throw error;
	}
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
	hooksDir: DirectoryRef,
	packagedMarketplace: PackagedOmxMarketplace,
): Promise<void> {
	await writeRegularFileChild(
		hooksDir,
		OMX_PLUGIN_HOOK_LAUNCHER_FILE,
		buildPinnedHookLauncherContent(packagedMarketplace),
	);
}

async function applyTeamModeToPluginCache(
	cacheDir: DirectoryRef,
	teamMode: SetupTeamMode | undefined,
): Promise<void> {
	if (teamModeEnabled(teamMode)) return;
	let skillsDir: DirectoryRef;
	try {
		skillsDir = await openDirectoryChild(cacheDir, "skills");
	} catch (error) {
		if (isMissingPathError(error)) return;
		throw error;
	}
	try {
		for (const skillName of TEAM_MODE_PLUGIN_SKILL_NAMES) {
			await removeChild(skillsDir, skillName, { recursive: true, force: true });
		}
	} finally {
		await skillsDir.handle.close();
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
	anchoredCacheBaseRef?: DirectoryRef,
): Promise<string[]> {
	const cacheBase = omxPluginCacheBase(codexHomeDir);
	const noFollowFlags = fsConstants.O_NOFOLLOW;
	const directoryFlags = fsConstants.O_DIRECTORY;
	if (typeof noFollowFlags !== "number" || typeof directoryFlags !== "number") {
		throw new Error("platform cannot provide no-follow directory anchoring for cache retirement");
	}
	let baseRef = anchoredCacheBaseRef;
	let ownsBaseRef = false;
	const candidateRefs: DirectoryRef[] = [];
	try {
		if (!baseRef) {
			baseRef = await openDirectoryRef(cacheBase);
			ownsBaseRef = true;
		}
		const entries = await readdir(baseRef.operationPath, { withFileTypes: true });
		const managed: Array<{ path: string; version: string; mtimeMs: number; ref: DirectoryRef; stats: Stats }> = [];
		for (const entry of entries) {
			if (!entry.isDirectory() || entry.name === currentVersion) continue;
			let candidateRef: DirectoryRef;
			try {
				candidateRef = await openDirectoryChild(baseRef, entry.name);
			} catch {
				continue;
			}
			const candidateStats = await candidateRef.handle.stat();
			if (!candidateStats.isDirectory() || candidateStats.isSymbolicLink()) {
				await candidateRef.handle.close();
				continue;
			}
			candidateRefs.push(candidateRef);
			const manifest = await readRegularOmxPluginCacheManifest(candidateRef.path, candidateRef.path);
			if (manifest?.name !== OMX_PLUGIN_NAME || manifest.version !== entry.name) continue;
			if (!(await hasRegularPublicationMarker(candidateRef.path, ".omx-complete")) || await hasRegularPublicationMarker(candidateRef.path, ".omx-incomplete")) continue;
			if (await readOmxPluginCacheFileNoFollow(join(candidateRef.path, ".omx-live-pin"), { anchorDir: candidateRef.path }) !== null) continue;
			managed.push({ path: join(cacheBase, entry.name), version: entry.name, mtimeMs: candidateStats.mtimeMs, ref: candidateRef, stats: candidateStats });
		}
		managed.sort((left, right) =>
			right.version.localeCompare(left.version, undefined, { numeric: true }) ||
			right.mtimeMs - left.mtimeMs,
		);
		const retired: string[] = [];
		for (const candidate of managed.slice(1)) {
			await assertDirectoryRef(baseRef, "retirement");
			const currentStats = await lstat(candidate.ref.path);
			if (!currentStats.isDirectory() || currentStats.isSymbolicLink() || currentStats.dev !== candidate.stats.dev || currentStats.ino !== candidate.stats.ino) {
				throw new Error(`managed cache retirement target changed before removal: ${candidate.path}`);
			}
			await removeChild(baseRef, candidate.version, { recursive: true, force: true });
			retired.push(candidate.path);
		}
		return retired;
	} finally {
		for (const candidateRef of candidateRefs.reverse()) await candidateRef.handle.close();
		if (ownsBaseRef && baseRef) await baseRef.handle.close();
	}
}

interface MaterializePackagedOmxPluginCacheOptions {
	dryRun?: boolean;
	teamMode?: SetupTeamMode;
	onCacheDirPrepared?: (cacheDir: string) => void | Promise<void>;
	anchoredCacheBaseRef?: DirectoryRef;
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
				: await retireUnpinnedManagedSnapshots(codexHomeDir, version, options.anchoredCacheBaseRef),
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
			retiredDirs: options.dryRun ? [] : await retireUnpinnedManagedSnapshots(codexHomeDir, version, options.anchoredCacheBaseRef),
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
				retiredDirs: options.dryRun ? [] : await retireUnpinnedManagedSnapshots(codexHomeDir, version, options.anchoredCacheBaseRef),
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
				retiredDirs: options.dryRun ? [] : await retireUnpinnedManagedSnapshots(codexHomeDir, version, options.anchoredCacheBaseRef),
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
				retiredDirs: options.dryRun ? [] : await retireUnpinnedManagedSnapshots(codexHomeDir, version, options.anchoredCacheBaseRef),
			};
		}
		return {
			status: "unchanged",
			cacheDir,
			version,
			retiredDirs: options.dryRun ? [] : await retireUnpinnedManagedSnapshots(codexHomeDir, version, options.anchoredCacheBaseRef),
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
		let cacheBaseRef = options.anchoredCacheBaseRef;
		let ownsCacheBaseRef = false;
		if (!cacheBaseRef) {
			cacheBaseRef = await openDirectoryRef(cacheBase);
			ownsCacheBaseRef = true;
		}
		let lockHandle: FileHandle;
		try {
			lockHandle = await claimPublicationLock(cacheBaseRef, cacheBase, noFollowFlags);
		} catch (error) {
			if (ownsCacheBaseRef) await cacheBaseRef.handle.close();
			return {
				status: "stale-launcher",
				cacheDir,
				version,
				reason: `cannot claim immutable OMX plugin cache publication at ${cacheBase}: ${(error as Error).message}`,
				launcherTarget: undefined,
				retiredDirs: [],
			};
		}
		let tempName: string | undefined;
		let tempRef: DirectoryRef | undefined;
		let snapshotRef: DirectoryRef | undefined;
		let outcome: OmxPluginCacheMaterializeResult = {
			status: "materialized",
			cacheDir,
			version,
			retiredDirs: [],
		};
		let cleanupError: unknown = null;
		let lockIdentity: Stats | undefined;
		let finalRef: DirectoryRef | undefined;
		try {
			lockIdentity = await lockHandle.stat();
			await assertDirectoryRef(cacheBaseRef, "temporary staging");
			const tempDir = await mkdtemp(join(cacheBaseRef.path, `.omx-plugin-${version}-`));
			await assertDirectoryRef(cacheBaseRef, "temporary staging");
			tempName = tempDir.slice(cacheBaseRef.path.length + 1);
			if (!tempName || tempName.includes("/")) throw new Error("temporary staging directory escaped the anchored cache namespace");
			tempRef = await openDirectoryChild(cacheBaseRef, tempName);
			snapshotRef = await stageCompletePluginSnapshot(tempRef, packagedMarketplace, version, options.teamMode);
			await syncDirectoryTree(snapshotRef);
			await options.onCacheDirPrepared?.(cacheDir);
			try {
				await createExclusiveFileChild(snapshotRef, ".omx-complete", `${process.pid}\n`);
				await removeChild(snapshotRef, ".omx-incomplete", { force: true });
				await syncDirectoryTree(snapshotRef);
				await renameChild(tempRef, "snapshot", cacheBaseRef, version);
				await snapshotRef.handle.close();
				snapshotRef = undefined;
				finalRef = await openDirectoryChild(cacheBaseRef, version);
				await assertDirectoryRef(finalRef, "publication validation");
				const finalPathStats = await lstat(finalRef.path);
				const finalDescriptorStats = await finalRef.handle.stat();
				if (!finalPathStats.isDirectory() || finalPathStats.isSymbolicLink() || finalPathStats.dev !== finalDescriptorStats.dev || finalPathStats.ino !== finalDescriptorStats.ino) {
					throw new Error(`published cache directory changed before validation: ${cacheDir}`);
				}
				await cacheBaseRef.handle.sync();
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
			try { if (finalRef) await finalRef.handle.close(); } catch (error) { cleanupError ??= error; }
			try { if (snapshotRef) await snapshotRef.handle.close(); } catch (error) { cleanupError ??= error; }
			try { if (tempRef) await tempRef.handle.close(); } catch (error) { cleanupError ??= error; }
			try { if (tempName) await removeChild(cacheBaseRef, tempName, { recursive: true, force: true }); } catch (error) { cleanupError = error; }
			try { await lockHandle.close(); } catch (error) { cleanupError ??= error; }
			try {
				if (!lockIdentity) throw new Error(`publication lock identity unavailable at ${cacheBase}`);
				await reclaimStalePublicationLock(cacheBaseRef, ".omx-publish.lock", lockIdentity);
				await cacheBaseRef.handle.sync();
			} catch (error) { cleanupError ??= error; }
			if (ownsCacheBaseRef) {
				try { await cacheBaseRef.handle.close(); } catch (error) { cleanupError ??= error; }
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
					options.anchoredCacheBaseRef,
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
			: await retireUnpinnedManagedSnapshots(codexHomeDir, version, options.anchoredCacheBaseRef),
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
	let namespace: { handle: FileHandle; fdPath: string; path: string; handles: FileHandle[] } | null;
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
				anchoredCacheBaseRef: {
					handle: namespace.handle,
					path: namespace.path,
					operationPath: cacheBaseFdPath,
				},
				anchoredCacheDir: join(namespace.fdPath, version),
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
