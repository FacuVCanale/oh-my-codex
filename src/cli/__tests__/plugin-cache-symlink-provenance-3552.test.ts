import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import {
  cp,
  lstat,
  link,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  PLUGIN_LAUNCHER_RECOVERY_HINT,
  hasExpectedOmxPluginCache,
  materializePackagedOmxPluginCache,
  readOmxPluginCacheFileNoFollow,
  omxPluginCacheProvenanceReason,
  omxPluginCacheExecutedAssetProvenanceReason,
  pluginHookCacheMatchesPackaged,
  readOmxPluginCacheState,
  discoverOmxPluginCacheDirs,
  resolvePackagedOmxMarketplace,
} from "../plugin-marketplace.js";

const packageRoot = process.cwd();

async function withIsolatedUserHome<T>(
  wd: string,
  fn: (codexHomeDir: string) => Promise<T>,
): Promise<T> {
  const home = join(wd, "home");
  await mkdir(home, { recursive: true });
  const previousHome = process.env.CODEX_HOME;
  process.env.CODEX_HOME = home;
  try {
    return await fn(home);
  } finally {
    if (previousHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousHome;
  }
}

async function packagedPluginVersion(): Promise<string> {
  const manifest = JSON.parse(
    await readFile(
      join(packageRoot, "plugins", "oh-my-codex", ".codex-plugin", "plugin.json"),
      "utf-8",
    ),
  ) as { version: string };
  return manifest.version;
}

async function expectedPackagedSkillNames(): Promise<string[]> {
  const entries = await readdir(
    join(packageRoot, "plugins", "oh-my-codex", "skills"),
    { withFileTypes: true },
  );
  return entries.filter((e) => e.isDirectory()).map((e) => e.name).sort();
}

async function pinnedLauncherContent(): Promise<string> {
  return `${JSON.stringify(
    {
      command: process.execPath,
      argsPrefix: [join(packageRoot, "dist", "cli", "omx.js")],
    },
    null,
    2,
  )}\n`;
}

/**
 * Seeds a byte-identical regular cache snapshot for the current packageRoot,
 * exactly like `stageCompletePluginSnapshot` + materialize would produce.
 */
async function seedRegularSnapshot(codexHomeDir: string): Promise<string> {
  const version = await packagedPluginVersion();
  const cacheDir = join(
    codexHomeDir,
    "plugins",
    "cache",
    "oh-my-codex-local",
    "oh-my-codex",
    version,
  );
  await mkdir(dirname(cacheDir), { recursive: true });
  await cp(join(packageRoot, "plugins", "oh-my-codex"), cacheDir, {
    recursive: true,
  });
  await writeFile(
    join(cacheDir, "hooks", "omx-command.json"),
    await pinnedLauncherContent(),
  );
  await writeFile(join(cacheDir, ".omx-complete"), "fixture\n");
  return cacheDir;
}

describe("issue 3552 P1 symlink trust bypass in unchanged fast paths", () => {
  it("control: regular immutable snapshot stays unchanged and hook-matching", async () => {
    const wd = await mkdtemp(join(tmpdir(), "omx-3552-control-"));
    try {
      await withIsolatedUserHome(wd, async (codexHomeDir) => {
        const packaged = await resolvePackagedOmxMarketplace(packageRoot);
        assert.ok(packaged);
        const cacheDir = await seedRegularSnapshot(codexHomeDir);
        assert.equal((await lstat(cacheDir)).isSymbolicLink(), false);
        assert.equal(
          await omxPluginCacheExecutedAssetProvenanceReason(cacheDir),
          null,
        );
        assert.equal(await pluginHookCacheMatchesPackaged(cacheDir, packaged), true);
        assert.equal(
          await hasExpectedOmxPluginCache(codexHomeDir, packaged),
          true,
        );
        const r = await materializePackagedOmxPluginCache(codexHomeDir, packaged);
        assert.equal(r.status, "unchanged");
      });
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it("fails closed when the committed publication marker is removed", async () => {
    const wd = await mkdtemp(join(tmpdir(), "omx-3552-marker-loss-"));
    try {
      await withIsolatedUserHome(wd, async (codexHomeDir) => {
        const packaged = await resolvePackagedOmxMarketplace(packageRoot);
        assert.ok(packaged);
        const first = await materializePackagedOmxPluginCache(codexHomeDir, packaged);
        assert.equal(first.status, "materialized");
        await rm(join(first.cacheDir!, ".omx-complete"), { force: true });
        assert.equal(await hasExpectedOmxPluginCache(codexHomeDir, packaged), false);
        const result = await materializePackagedOmxPluginCache(codexHomeDir, packaged);
        assert.equal(result.status, "stale-launcher");
        assert.match(result.reason ?? "", /managed snapshots|publication marker|codex plugin remove/);
      });
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it("rejects extra skill directories from immutable provenance", async () => {
    const wd = await mkdtemp(join(tmpdir(), "omx-3552-extra-skill-"));
    try {
      await withIsolatedUserHome(wd, async (codexHomeDir) => {
        const packaged = await resolvePackagedOmxMarketplace(packageRoot);
        assert.ok(packaged);
        const cacheDir = await seedRegularSnapshot(codexHomeDir);
        await mkdir(join(cacheDir, "skills", "attacker"), { recursive: true });
        await writeFile(join(cacheDir, "skills", "attacker", "SKILL.md"), "attacker\n");
        assert.equal(await hasExpectedOmxPluginCache(codexHomeDir, packaged), false);
        const result = await materializePackagedOmxPluginCache(codexHomeDir, packaged);
        assert.equal(result.status, "stale-launcher");
        assert.match(result.reason ?? "", /skills directory contents differ/);
      });
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it("fails closed at the state boundary for missing managed assets", async () => {
    const wd = await mkdtemp(join(tmpdir(), "omx-3552-state-boundary-"));
    try {
      await withIsolatedUserHome(wd, async (codexHomeDir) => {
        const cacheDir = await seedRegularSnapshot(codexHomeDir);
        await rm(join(cacheDir, "hooks", "hooks.json"), { force: true });
        assert.equal(await readOmxPluginCacheState(cacheDir), null);
      });
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it("fails closed when state surfaces have invalid pointers, companions, skills, or launcher", async () => {
    const cases = [
      ["pointer", async (cacheDir: string) => {
        const manifestPath = join(cacheDir, ".codex-plugin", "plugin.json");
        const manifest = JSON.parse(await readFile(manifestPath, "utf-8")) as Record<string, unknown>;
        await writeFile(manifestPath, JSON.stringify({ ...manifest, skills: "./attacker-skills/" }));
      }],
      ["companion", async (cacheDir: string) => {
        await writeFile(join(cacheDir, ".mcp.json"), "not-json\n");
      }],
      ["skill", async (cacheDir: string) => {
        await rm(join(cacheDir, "skills", "worker", "SKILL.md"), { force: true });
      }],
      ["launcher", async (cacheDir: string) => {
        await writeFile(join(cacheDir, "hooks", "omx-command.json"), "{}\n");
      }],
    ] as const;
    for (const [label, mutate] of cases) {
      const wd = await mkdtemp(join(tmpdir(), `omx-3552-state-${label}-`));
      try {
        await withIsolatedUserHome(wd, async (codexHomeDir) => {
          const cacheDir = await seedRegularSnapshot(codexHomeDir);
          await mutate(cacheDir);
          assert.equal(await readOmxPluginCacheState(cacheDir), null, `${label} state failure was trusted`);
        });
      } finally {
        await rm(wd, { recursive: true, force: true });
      }
    }
  });

  it("rejects an anchored parent replacement before reading a managed asset", async () => {
    const wd = await mkdtemp(join(tmpdir(), "omx-3552-parent-barrier-"));
    try {
      await withIsolatedUserHome(wd, async (codexHomeDir) => {
        const cacheDir = await seedRegularSnapshot(codexHomeDir);
        const hooksDir = join(cacheDir, "hooks");
        const externalDir = join(wd, "external-hooks");
        await rename(hooksDir, externalDir);
        await symlink(externalDir, hooksDir);
        const bytes = await readOmxPluginCacheFileNoFollow(
          join(cacheDir, "hooks", "hooks.json"),
          { anchorDir: cacheDir },
        );
        assert.equal(bytes, null);
      });
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it("rejects a symlinked intermediate skills directory during descriptor-bound reads", async () => {
    const wd = await mkdtemp(join(tmpdir(), "omx-3552-intermediate-skills-symlink-"));
    try {
      await withIsolatedUserHome(wd, async (codexHomeDir) => {
        const cacheDir = await seedRegularSnapshot(codexHomeDir);
        const skillsDir = join(cacheDir, "skills");
        const externalSkills = join(wd, "external-skills");
        await rename(skillsDir, externalSkills);
        await symlink(externalSkills, skillsDir);
        assert.equal(
          await readOmxPluginCacheFileNoFollow(
            join(cacheDir, "skills", "worker", "SKILL.md"),
            { anchorDir: cacheDir },
          ),
          null,
        );
      });
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it("rejects an interrupted publication without a committed marker", async () => {
    const wd = await mkdtemp(join(tmpdir(), "omx-3552-publication-interrupt-"));
    try {
      await withIsolatedUserHome(wd, async (codexHomeDir) => {
        const packaged = await resolvePackagedOmxMarketplace(packageRoot);
        assert.ok(packaged);
        const cacheDir = await seedRegularSnapshot(codexHomeDir);
        await rm(join(cacheDir, ".omx-complete"), { force: true });
        await writeFile(join(cacheDir, ".omx-incomplete"), "interrupted\n");
        assert.equal(await hasExpectedOmxPluginCache(codexHomeDir, packaged), false);
        assert.equal(await readOmxPluginCacheState(cacheDir), null);
      });
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it("does not discover a manifest without a committed publication marker", async () => {
    const wd = await mkdtemp(join(tmpdir(), "omx-3552-discovery-marker-"));
    try {
      await withIsolatedUserHome(wd, async (codexHomeDir) => {
        const cacheDir = await seedRegularSnapshot(codexHomeDir);
        await rm(join(cacheDir, ".omx-complete"), { force: true });
        assert.deepEqual(await discoverOmxPluginCacheDirs(codexHomeDir), []);
      });
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it("symlinked current-version cache root is rejected: no unchanged, no external mutation, stale-launcher with recovery hint", async () => {
    const wd = await mkdtemp(join(tmpdir(), "omx-3552-root-symlink-"));
    try {
      await withIsolatedUserHome(wd, async (codexHomeDir) => {
        const packaged = await resolvePackagedOmxMarketplace(packageRoot);
        assert.ok(packaged);
        const realCache = await seedRegularSnapshot(codexHomeDir);
        // Attacker relocates the snapshot outside the managed namespace and
        // replaces the <version> root with a symlink to it.
        const externalTarget = join(wd, "external", "snapshot");
        await mkdir(dirname(externalTarget), { recursive: true });
        await rename(realCache, externalTarget);
        await symlink(externalTarget, realCache);
        assert.equal((await lstat(realCache)).isSymbolicLink(), true);

        // Fast path must refuse the symlinked root instead of reading through it.
        assert.equal(
          await hasExpectedOmxPluginCache(codexHomeDir, packaged),
          false,
          "symlinked cache root must not satisfy hasExpectedOmxPluginCache",
        );
        assert.equal(
          await readOmxPluginCacheState(realCache),
          null,
          "cache state must not be read through a symlinked root",
        );
        assert.equal(
          await pluginHookCacheMatchesPackaged(realCache, packaged),
          false,
          "hook assets behind a symlinked root must not match",
        );

        const r = await materializePackagedOmxPluginCache(codexHomeDir, packaged);
        assert.equal(r.status, "stale-launcher", JSON.stringify(r));
        assert.match(r.reason!, /symlink or non-directory/);
        assert.match(
          r.reason!,
          new RegExp(PLUGIN_LAUNCHER_RECOVERY_HINT.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
        );

        // Non-mutation proof: the external target stays exactly where the attacker
        // put it (setup neither followed nor rewrote it), and the external copy is
        // still attacker-writable — which is precisely why it can never be trusted.
        const sentinel = await readFile(
          join(externalTarget, "hooks", "hooks.json"),
          "utf-8",
        );
        const packagedHook = await readFile(
          join(packageRoot, "plugins", "oh-my-codex", "hooks", "hooks.json"),
          "utf-8",
        );
        assert.equal(sentinel, packagedHook, "external target untouched by setup");
        await writeFile(
          join(externalTarget, "hooks", "hooks.json"),
          "// attacker mutation\n",
        );
        const mutatedExternal = await readFile(
          join(realCache, "hooks", "hooks.json"),
          "utf-8",
        );
        assert.equal(
          mutatedExternal,
          "// attacker mutation\n",
          "proof the pre-fix trust boundary would have followed the external target",
        );
        assert.equal(
          await pluginHookCacheMatchesPackaged(realCache, packaged),
          false,
          "mutated external target must still never match after the mutation",
        );
        assert.equal(existsSync(realCache), true);
        assert.equal((await lstat(realCache)).isSymbolicLink(), true);
      });
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  const assetCases = [
    ["hooks.json", false],
    ["codex-native-hook.mjs", false],
    ["omx-command.json", true],
  ] as const;

  for (const [asset, isLauncher] of assetCases) {
    it(`symlinked hooks/${asset} with byte-identical external content is rejected (unchanged fast path + materializer)`, async () => {
      const wd = await mkdtemp(join(tmpdir(), `omx-3552-asset-${asset.replace(/[^a-z]/g, "")}-`));
      try {
        await withIsolatedUserHome(wd, async (codexHomeDir) => {
          const packaged = await resolvePackagedOmxMarketplace(packageRoot);
          assert.ok(packaged);
          const cacheDir = await seedRegularSnapshot(codexHomeDir);
          const assetPath = join(cacheDir, "hooks", asset);
          const external = join(wd, "external", asset);
          await mkdir(dirname(external), { recursive: true });
          // Byte-identical content moved outside the managed namespace.
          await rename(assetPath, external);
          await symlink(external, assetPath);
          assert.equal((await lstat(assetPath)).isSymbolicLink(), true);
          assert.equal(
            (await readFile(assetPath, "utf-8")) === (await readFile(external, "utf-8")),
            true,
            "external target is byte-identical (the pre-fix trust bypass condition)",
          );

          const reason = await omxPluginCacheExecutedAssetProvenanceReason(cacheDir);
          assert.ok(reason, `${asset} symlink must produce a provenance reason`);
          assert.match(reason, new RegExp(asset.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
          assert.match(reason, /symlink or not a regular file/);
          assert.equal(
            await pluginHookCacheMatchesPackaged(cacheDir, packaged),
            false,
            `symlinked ${asset} must not satisfy hook cache matching`,
          );
          if (!isLauncher) {
            // hooks.json / codex-native-hook.mjs mismatches flip hasExpectedOmxPluginCache
            assert.equal(
              await hasExpectedOmxPluginCache(codexHomeDir, packaged),
              false,
              `symlinked ${asset} must not satisfy hasExpectedOmxPluginCache`,
            );
          }
          const r = await materializePackagedOmxPluginCache(codexHomeDir, packaged);
          assert.equal(r.status, "stale-launcher", JSON.stringify(r));
          assert.match(r.reason!, /symlink or not a regular file/);
          assert.match(
            r.reason!,
            new RegExp(PLUGIN_LAUNCHER_RECOVERY_HINT.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
          );

          // Non-mutation proof: the symlink and the external target both survive
          // the materializer run untouched (#3499 immutability preserved), and a
          // later external mutation never flips the verdict back to trusted.
          assert.equal((await lstat(assetPath)).isSymbolicLink(), true);
          await writeFile(external, "// attacker mutation\n");
          const r2 = await materializePackagedOmxPluginCache(codexHomeDir, packaged);
          assert.equal(r2.status, "stale-launcher", "mutated external target stays rejected");
          assert.equal(
            (await readFile(assetPath, "utf-8")),
            "// attacker mutation\n",
            "reads through the symlink follow the attacker target (why it is untrusted)",
          );
        });
      } finally {
        await rm(wd, { recursive: true, force: true });
      }
    });
  }

  it("symlinked hooks directory itself is rejected before any executed-asset read", async () => {
    const wd = await mkdtemp(join(tmpdir(), "omx-3552-hooks-dir-symlink-"));
    try {
      await withIsolatedUserHome(wd, async (codexHomeDir) => {
        const packaged = await resolvePackagedOmxMarketplace(packageRoot);
        assert.ok(packaged);
        const cacheDir = await seedRegularSnapshot(codexHomeDir);
        const external = join(wd, "external", "hooks");
        await mkdir(dirname(external), { recursive: true });
        await rename(join(cacheDir, "hooks"), external);
        await symlink(external, join(cacheDir, "hooks"));
        assert.equal((await lstat(join(cacheDir, "hooks"))).isSymbolicLink(), true);

        const reason = await omxPluginCacheExecutedAssetProvenanceReason(cacheDir);
        assert.ok(reason);
        assert.match(reason, /symlink or not a directory/);
        assert.equal(
          await pluginHookCacheMatchesPackaged(cacheDir, packaged),
          false,
        );
        assert.equal(
          await hasExpectedOmxPluginCache(codexHomeDir, packaged),
          false,
        );
        const r = await materializePackagedOmxPluginCache(codexHomeDir, packaged);
        assert.equal(r.status, "stale-launcher", JSON.stringify(r));
        assert.match(r.reason!, /symlink or not a (regular file|directory)/);
      });
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it("non-regular executed asset (FIFO replaced by directory) is rejected fail-closed", async () => {
    const wd = await mkdtemp(join(tmpdir(), "omx-3552-nonregular-"));
    try {
      await withIsolatedUserHome(wd, async (codexHomeDir) => {
        const packaged = await resolvePackagedOmxMarketplace(packageRoot);
        assert.ok(packaged);
        const cacheDir = await seedRegularSnapshot(codexHomeDir);
        await rm(join(cacheDir, "hooks", "hooks.json"), { force: true });
        await mkdir(join(cacheDir, "hooks", "hooks.json"));
        const reason = await omxPluginCacheExecutedAssetProvenanceReason(cacheDir);
        assert.ok(reason);
        assert.match(reason, /symlink or not a regular file/);
        assert.equal(await pluginHookCacheMatchesPackaged(cacheDir, packaged), false);
        const r = await materializePackagedOmxPluginCache(codexHomeDir, packaged);
        assert.equal(r.status, "stale-launcher", JSON.stringify(r));
      });
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it("manifest pointer drift is rejected before an existing snapshot can return unchanged", async () => {
    const wd = await mkdtemp(join(tmpdir(), "omx-3552-manifest-drift-"));
    try {
      await withIsolatedUserHome(wd, async (codexHomeDir) => {
        const packaged = await resolvePackagedOmxMarketplace(packageRoot);
        assert.ok(packaged);
        const cacheDir = await seedRegularSnapshot(codexHomeDir);
        const manifestPath = join(cacheDir, ".codex-plugin", "plugin.json");
        const manifest = JSON.parse(await readFile(manifestPath, "utf-8")) as Record<string, unknown>;
        await writeFile(
          manifestPath,
          JSON.stringify({ ...manifest, skills: "./attacker-skills/", hooks: "./attacker-hooks/hooks.json" }),
        );

        assert.equal(await hasExpectedOmxPluginCache(codexHomeDir, packaged), false);
        const r = await materializePackagedOmxPluginCache(codexHomeDir, packaged);
        assert.equal(r.status, "stale-launcher", JSON.stringify(r));
        assert.match(r.reason!, /manifest (skills|hooks) pointer/);
        assert.match(r.reason!, new RegExp(PLUGIN_LAUNCHER_RECOVERY_HINT.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
        assert.match(await readFile(manifestPath, "utf-8"), /attacker-skills/);
      });
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it("symlinked manifest is rejected even when its external content is canonical", async () => {
    const wd = await mkdtemp(join(tmpdir(), "omx-3552-manifest-symlink-"));
    try {
      await withIsolatedUserHome(wd, async (codexHomeDir) => {
        const packaged = await resolvePackagedOmxMarketplace(packageRoot);
        assert.ok(packaged);
        const cacheDir = await seedRegularSnapshot(codexHomeDir);
        const manifestPath = join(cacheDir, ".codex-plugin", "plugin.json");
        const externalManifest = join(wd, "external", "plugin.json");
        await mkdir(dirname(externalManifest), { recursive: true });
        await rename(manifestPath, externalManifest);
        await symlink(externalManifest, manifestPath);

        assert.equal((await lstat(manifestPath)).isSymbolicLink(), true);
        assert.equal(await hasExpectedOmxPluginCache(codexHomeDir, packaged), false);
        const r = await materializePackagedOmxPluginCache(codexHomeDir, packaged);
        assert.equal(r.status, "stale-launcher", JSON.stringify(r));
        assert.match(r.reason!, /plugin manifest .*symlink/);
        assert.equal((await lstat(manifestPath)).isSymbolicLink(), true);
        assert.equal(await readFile(externalManifest, "utf-8"), await readFile(join(packaged.pluginRoot, ".codex-plugin", "plugin.json"), "utf-8"));
      });
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it("skills directory symlink with matching names and attacker content is rejected and preserved", async () => {
    const wd = await mkdtemp(join(tmpdir(), "omx-3552-skills-symlink-"));
    try {
      await withIsolatedUserHome(wd, async (codexHomeDir) => {
        const packaged = await resolvePackagedOmxMarketplace(packageRoot);
        assert.ok(packaged);
        const cacheDir = await seedRegularSnapshot(codexHomeDir);
        const skillsPath = join(cacheDir, "skills");
        const externalSkills = join(wd, "external", "skills");
        await mkdir(dirname(externalSkills), { recursive: true });
        await rename(skillsPath, externalSkills);
        await writeFile(join(externalSkills, "worker", "SKILL.md"), "# attacker-controlled skill\n");
        await symlink(externalSkills, skillsPath);

        assert.equal((await lstat(skillsPath)).isSymbolicLink(), true);
        assert.equal(await hasExpectedOmxPluginCache(codexHomeDir, packaged), false);
        const r = await materializePackagedOmxPluginCache(codexHomeDir, packaged);
        assert.equal(r.status, "stale-launcher", JSON.stringify(r));
        assert.match(r.reason!, /skills directory .*symlink/);
        assert.equal((await lstat(skillsPath)).isSymbolicLink(), true);
        assert.equal(await readFile(join(externalSkills, "worker", "SKILL.md"), "utf-8"), "# attacker-controlled skill\n");

        await writeFile(join(externalSkills, "worker", "SKILL.md"), "# attacker mutation\n");
        const r2 = await materializePackagedOmxPluginCache(codexHomeDir, packaged);
        assert.equal(r2.status, "stale-launcher", JSON.stringify(r2));
        assert.equal(await readFile(join(skillsPath, "worker", "SKILL.md"), "utf-8"), "# attacker mutation\n");
      });
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it("regular attacker-mutated SKILL.md content is rejected before unchanged acceptance", async () => {
    const wd = await mkdtemp(join(tmpdir(), "omx-3552-skill-content-"));
    try {
      await withIsolatedUserHome(wd, async (codexHomeDir) => {
        const packaged = await resolvePackagedOmxMarketplace(packageRoot);
        assert.ok(packaged);
        const cacheDir = await seedRegularSnapshot(codexHomeDir);
        const skillPath = join(cacheDir, "skills", "worker", "SKILL.md");
        const sentinel = "# attacker-mutated regular skill\n";
        await writeFile(skillPath, sentinel);

        assert.equal(await hasExpectedOmxPluginCache(codexHomeDir, packaged), false);
        const r = await materializePackagedOmxPluginCache(codexHomeDir, packaged);
        assert.equal(r.status, "stale-launcher", JSON.stringify(r));
        assert.match(r.reason!, /expected skill file content differs/);
        assert.equal(await readFile(skillPath, "utf-8"), sentinel);
      });
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  const companionCases = [".mcp.json", ".app.json"] as const;
  for (const companion of companionCases) {
    it(`${companion} content drift is rejected before unchanged acceptance`, async () => {
      const wd = await mkdtemp(join(tmpdir(), `omx-3552-${companion.slice(1)}-drift-`));
      try {
        await withIsolatedUserHome(wd, async (codexHomeDir) => {
          const packaged = await resolvePackagedOmxMarketplace(packageRoot);
          assert.ok(packaged);
          const cacheDir = await seedRegularSnapshot(codexHomeDir);
          const cachedPath = join(cacheDir, companion);
          const sentinel = `{"attacker":"${companion}"}\n`;
          await writeFile(cachedPath, sentinel);

          assert.equal(await hasExpectedOmxPluginCache(codexHomeDir, packaged), false);
          const r = await materializePackagedOmxPluginCache(codexHomeDir, packaged);
          assert.equal(r.status, "stale-launcher", JSON.stringify(r));
          assert.match(r.reason!, /companion file content differs/);
          assert.equal(await readFile(cachedPath, "utf-8"), sentinel);
        });
      } finally {
        await rm(wd, { recursive: true, force: true });
      }
    });

    it(`${companion} symlink with canonical external content is rejected and preserved`, async () => {
      const wd = await mkdtemp(join(tmpdir(), `omx-3552-${companion.slice(1)}-symlink-`));
      try {
        await withIsolatedUserHome(wd, async (codexHomeDir) => {
          const packaged = await resolvePackagedOmxMarketplace(packageRoot);
          assert.ok(packaged);
          const cacheDir = await seedRegularSnapshot(codexHomeDir);
          const cachedPath = join(cacheDir, companion);
          const externalPath = join(wd, "external", companion);
          await mkdir(dirname(externalPath), { recursive: true });
          await rename(cachedPath, externalPath);
          await symlink(externalPath, cachedPath);

          assert.equal((await lstat(cachedPath)).isSymbolicLink(), true);
          assert.equal(await hasExpectedOmxPluginCache(codexHomeDir, packaged), false);
          const r = await materializePackagedOmxPluginCache(codexHomeDir, packaged);
          assert.equal(r.status, "stale-launcher", JSON.stringify(r));
          assert.match(r.reason!, /companion file .*symlink/);
          assert.equal((await lstat(cachedPath)).isSymbolicLink(), true);
          await writeFile(externalPath, "{\"attacker\":true}\n");
          const r2 = await materializePackagedOmxPluginCache(codexHomeDir, packaged);
          assert.equal(r2.status, "stale-launcher", JSON.stringify(r2));
          assert.equal(await readFile(cachedPath, "utf-8"), "{\"attacker\":true}\n");
        });
      } finally {
        await rm(wd, { recursive: true, force: true });
      }
    });

    it(`${companion} non-regular entry is rejected fail-closed`, async () => {
      const wd = await mkdtemp(join(tmpdir(), `omx-3552-${companion.slice(1)}-nonregular-`));
      try {
        await withIsolatedUserHome(wd, async (codexHomeDir) => {
          const packaged = await resolvePackagedOmxMarketplace(packageRoot);
          assert.ok(packaged);
          const cacheDir = await seedRegularSnapshot(codexHomeDir);
          const cachedPath = join(cacheDir, companion);
          await rm(cachedPath, { force: true });
          await mkdir(cachedPath);

          assert.equal(await hasExpectedOmxPluginCache(codexHomeDir, packaged), false);
          const r = await materializePackagedOmxPluginCache(codexHomeDir, packaged);
          assert.equal(r.status, "stale-launcher", JSON.stringify(r));
          assert.match(r.reason!, /companion file .*not a regular file/);
        });
      } finally {
        await rm(wd, { recursive: true, force: true });
      }
    });
  }

  it("rejects companion symlink swaps during descriptor-bound provenance validation", async () => {
    const wd = await mkdtemp(join(tmpdir(), "omx-3552-companion-toctou-"));
    try {
      await withIsolatedUserHome(wd, async (codexHomeDir) => {
        const packaged = await resolvePackagedOmxMarketplace(packageRoot);
        assert.ok(packaged);
        const cacheDir = await seedRegularSnapshot(codexHomeDir);
        for (const companion of companionCases) {
          const cachedPath = join(cacheDir, companion);
          const externalPath = join(wd, "external", companion);
          const canonical = await readFile(cachedPath);
          await mkdir(dirname(externalPath), { recursive: true });
			await writeFile(externalPath, `{"attacker":"${companion}"}\n`);
			for (let iteration = 0; iteration < 2000; iteration += 1) {
				await rm(cachedPath, { force: true });
				await symlink(externalPath, cachedPath);
				const reason = await omxPluginCacheProvenanceReason(cacheDir, packaged);
				assert.match(reason ?? "", /companion file .*symlink/);
				await rm(cachedPath, { force: true });
				await writeFile(cachedPath, canonical);
			}
          assert.equal(await readFile(externalPath, "utf-8"), `{"attacker":"${companion}"}\n`);
        }
      });
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it("does not replace a same-version cache claimed concurrently", async () => {
    const wd = await mkdtemp(join(tmpdir(), "omx-3552-cache-claim-race-"));
    try {
      await withIsolatedUserHome(wd, async (codexHomeDir) => {
        const packaged = await resolvePackagedOmxMarketplace(packageRoot);
        assert.ok(packaged);
        const results = await Promise.all([
          materializePackagedOmxPluginCache(codexHomeDir, packaged),
          materializePackagedOmxPluginCache(codexHomeDir, packaged),
        ]);
        assert.ok(results.every((result) => result.status !== "unavailable"));
        assert.ok(results.some((result) => result.status === "materialized" || result.status === "unchanged"));
        const cacheDir = results.find((result) => result.cacheDir)?.cacheDir;
        assert.ok(cacheDir);
        assert.equal(existsSync(join(cacheDir, ".omx-incomplete")), false);
        assert.equal(await hasExpectedOmxPluginCache(codexHomeDir, packaged), true);
      });
    } finally {
      await new Promise<void>((resolve) => setTimeout(resolve, 100));
      await rm(wd, { recursive: true, force: true });
    }
  });

  it("refuses a same-version directory claimed at the publication barrier", async () => {
    const wd = await mkdtemp(join(tmpdir(), "omx-3552-publication-barrier-"));
    try {
      await withIsolatedUserHome(wd, async (codexHomeDir) => {
        const packaged = await resolvePackagedOmxMarketplace(packageRoot);
        assert.ok(packaged);
        const version = await packagedPluginVersion();
        const cacheDir = join(
          codexHomeDir,
          "plugins",
          "cache",
          "oh-my-codex-local",
          "oh-my-codex",
          version,
        );
        const result = await materializePackagedOmxPluginCache(codexHomeDir, packaged, {
          onCacheDirPrepared: async (preparedCacheDir) => {
            assert.equal(preparedCacheDir, cacheDir);
            await mkdir(preparedCacheDir, { recursive: true });
            await writeFile(join(preparedCacheDir, "attacker-sentinel"), "preserve\n");
          },
        });
        assert.equal(result.status, "stale-launcher", JSON.stringify(result));
        assert.equal(await readFile(join(cacheDir, "attacker-sentinel"), "utf-8"), "preserve\n");
        assert.equal(existsSync(join(cacheDir, ".omx-complete")), false);
      });
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it("recovers a publication lock owned by a dead process", async () => {
    const wd = await mkdtemp(join(tmpdir(), "omx-3552-stale-publication-lock-"));
    try {
      await withIsolatedUserHome(wd, async (codexHomeDir) => {
        const packaged = await resolvePackagedOmxMarketplace(packageRoot);
        assert.ok(packaged);
        const cacheBase = join(codexHomeDir, "plugins", "cache", "oh-my-codex-local", "oh-my-codex");
        const lockPath = join(cacheBase, ".omx-publish.lock");
        await mkdir(cacheBase, { recursive: true });
        await writeFile(lockPath, JSON.stringify({ pid: 99999999, createdAt: Date.now() - 60_000 }));
        const result = await materializePackagedOmxPluginCache(codexHomeDir, packaged);
        assert.equal(result.status, "materialized", JSON.stringify(result));
        assert.equal(existsSync(lockPath), false);
        assert.equal(await hasExpectedOmxPluginCache(codexHomeDir, packaged), true);
      });
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it("keeps direct materialization dry-run read-only when the cache namespace is absent", async () => {
    const wd = await mkdtemp(join(tmpdir(), "omx-3552-dry-run-read-only-"));
    try {
      await withIsolatedUserHome(wd, async (codexHomeDir) => {
        const packaged = await resolvePackagedOmxMarketplace(packageRoot);
        assert.ok(packaged);
        const result = await materializePackagedOmxPluginCache(codexHomeDir, packaged, { dryRun: true });
        assert.equal(result.status, "materialized", JSON.stringify(result));
        assert.equal(existsSync(join(codexHomeDir, "plugins")), false);
      });
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it("does not accept attacker bytes after companion replacement", async () => {
    const wd = await mkdtemp(join(tmpdir(), "omx-3552-companion-concurrent-"));
    try {
      await withIsolatedUserHome(wd, async (codexHomeDir) => {
        const packaged = await resolvePackagedOmxMarketplace(packageRoot);
        assert.ok(packaged);
        const cacheDir = await seedRegularSnapshot(codexHomeDir);
        for (const companion of companionCases) {
          const cachedPath = join(cacheDir, companion);
          const externalPath = join(wd, "external", companion);
          const canonical = await readFile(cachedPath);
          await mkdir(dirname(externalPath), { recursive: true });
          await writeFile(externalPath, canonical);
          for (let iteration = 0; iteration < 2000; iteration += 1) {
            await rm(cachedPath, { force: true });
            await symlink(externalPath, cachedPath);
            await writeFile(externalPath, `{"attacker":"${companion}"}\n`);
            const rejected = await readOmxPluginCacheFileNoFollow(cachedPath);
            assert.equal(rejected, null, `${companion} accepted attacker-controlled symlink bytes`);
            await rm(cachedPath, { force: true });
            await writeFile(cachedPath, canonical);
            await writeFile(externalPath, canonical);
          }
          assert.equal((await readFile(externalPath)).equals(canonical), true);
        }
      });
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it("rejects hard-linked cache provenance files across shared surfaces", async () => {
    const wd = await mkdtemp(join(tmpdir(), "omx-3552-hardlink-"));
    try {
      await withIsolatedUserHome(wd, async (codexHomeDir) => {
        const packaged = await resolvePackagedOmxMarketplace(packageRoot);
        assert.ok(packaged);
        const surfaces = [
          ".mcp.json",
          ".app.json",
          ".codex-plugin/plugin.json",
          "skills/worker/SKILL.md",
          "hooks/hooks.json",
          "hooks/codex-native-hook.mjs",
          "hooks/omx-command.json",
        ];
        for (const surface of surfaces) {
          const cacheDir = await seedRegularSnapshot(codexHomeDir);
          const cachedPath = join(cacheDir, surface);
          const externalPath = join(wd, "hardlinks", surface.replaceAll("/", "-"));
          await mkdir(dirname(externalPath), { recursive: true });
          await link(cachedPath, externalPath);
          await rm(cachedPath, { force: true });
          await link(externalPath, cachedPath);

          const result = await materializePackagedOmxPluginCache(codexHomeDir, packaged);
          assert.notEqual(result.status, "unchanged", `${surface} hardlink was trusted`);
          assert.equal((await lstat(cachedPath)).nlink > 1, true);
          assert.equal((await readFile(externalPath)).equals(await readFile(cachedPath)), true);
          await rm(cacheDir, { recursive: true, force: true });
        }
      });
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });
});
