import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import {
	UPGRADE_FIXTURE_CONTEXT_MARKER,
	UPGRADE_FIXTURE_PLAN_MARKER,
	UPGRADE_FIXTURE_SPEC_MARKER,
	assertVersionedPluginRoots,
	cleanupUpgradeFixtureRoot,
	neutralizeStale020xState,
	run020To021UpgradeFixture,
	seed020xUpgradeFixture,
} from "../upgrade-from-0-20.js";

let previousPathForFakeCodex: string | undefined;
let fakeCodexBinDir: string | null = null;

before(async () => {
	previousPathForFakeCodex = process.env.PATH;
	fakeCodexBinDir = await mkdtemp(join(tmpdir(), "omx-upgrade-fake-codex-"));
	const fakeCodexPath = join(fakeCodexBinDir, "codex");
	await writeFile(
		fakeCodexPath,
		[
			"#!/usr/bin/env node",
			"if (process.argv[2] === 'features' && process.argv[3] === 'list') {",
			"  console.log('hooks                                   stable             true');",
			"  console.log('plugin_hooks                            experimental       true');",
			"  console.log('goals                                   experimental       true');",
			"  process.exit(0);",
			"}",
			"if (process.argv.includes('--version') || process.argv[2] === '--version') {",
			"  console.log('codex-cli 0.999.0');",
			"  process.exit(0);",
			"}",
			"process.exit(0);",
			"",
		].join("\n"),
	);
	await chmod(fakeCodexPath, 0o755);
	process.env.PATH = `${fakeCodexBinDir}${process.env.PATH ? `:${process.env.PATH}` : ""}`;
});

after(async () => {
	if (previousPathForFakeCodex === undefined) delete process.env.PATH;
	else process.env.PATH = previousPathForFakeCodex;
	if (fakeCodexBinDir !== null) {
		await rm(fakeCodexBinDir, { recursive: true, force: true });
	}
});

describe("0.20.x → 0.21 upgrade fixture", () => {
	it("neutralizes active 0.20.x state projections via C7 without deleting plans", async () => {
		const root = await mkdtemp(join(tmpdir(), "omx-upgrade-neutralize-"));
		try {
			const seed = await seed020xUpgradeFixture(root);
			const result = await neutralizeStale020xState(root);

			assert.equal(result.ran, true);
			assert.ok(result.touched.length >= 3, `expected neutralized files, got ${result.touched.length}`);

			for (const path of seed.statePaths) {
				// C7 scans root + scoped state dirs; session subdirs may only be
				// covered when state-paths includes them. Root projections must neutralize.
				if (!path.includes(`${join("state", "sessions")}`)) {
					const state = JSON.parse(await readFile(path, "utf-8")) as {
						active?: boolean;
						current_phase?: string;
						neutralized_by?: string;
					};
					assert.equal(state.active, false, path);
					assert.equal(state.current_phase, "cancelled", path);
					assert.equal(state.neutralized_by, "upgrade-0.21", path);
				}
			}

			assert.equal(await readFile(seed.planPath, "utf-8"), seed.planContent);
			assert.equal(await readFile(seed.specPath, "utf-8"), seed.specContent);
			assert.equal(await readFile(seed.contextPath, "utf-8"), seed.contextContent);
			assert.match(seed.planContent, new RegExp(UPGRADE_FIXTURE_PLAN_MARKER));
			assert.match(seed.specContent, new RegExp(UPGRADE_FIXTURE_SPEC_MARKER));
			assert.match(seed.contextContent, new RegExp(UPGRADE_FIXTURE_CONTEXT_MARKER));

			// Idempotent: second run is a no-op (marker).
			const second = await neutralizeStale020xState(root);
			assert.equal(second.ran, false);
			assert.equal(second.touched.length, 0);
		} finally {
			await cleanupUpgradeFixtureRoot(root);
		}
	});

	it("passes CLI (legacy) upgrade: state neutralized, plans preserved, hooks re-registered", async () => {
		const result = await run020To021UpgradeFixture({ mode: "legacy" });
		try {
			assert.equal(result.stateNeutralized, true, "state should neutralize");
			assert.equal(result.plansPreserved, true, "plans/specs/context must survive setup");
			assert.equal(result.hooksReregistered, true, "legacy hooks.json must re-register native hooks");
			assert.equal(result.pluginRootsVersioned, true);
		} finally {
			await cleanupUpgradeFixtureRoot(result.root);
		}
	});

	it("passes plugin-mode upgrade: state neutralized, plans preserved, hooks re-registered, versioned plugin roots", async () => {
		const result = await run020To021UpgradeFixture({
			mode: "plugin",
			retainPreviousPluginRoot: true,
		});
		try {
			assert.equal(result.stateNeutralized, true, "state should neutralize");
			assert.equal(result.plansPreserved, true, "plans/specs/context must survive plugin setup");
			assert.equal(
				result.hooksReregistered,
				true,
				"plugin-scoped hooks must re-register under versioned cache",
			);
			assert.equal(result.pluginRootsVersioned, true, "plugin cache root must be versioned");
			assert.ok(result.pluginCacheDir, "plugin cache dir should be known");
			assert.match(result.pluginCacheDir ?? "", /plugins[/\\]cache[/\\]oh-my-codex-local[/\\]oh-my-codex[/\\]/);

			const roots = await assertVersionedPluginRoots({
				codexHomeDir: result.codexHomeDir,
			});
			assert.equal(roots.ok, true, roots.message);
		} finally {
			await cleanupUpgradeFixtureRoot(result.root);
		}
	});
});
