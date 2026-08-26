import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  hasExpectedOmxPluginCache,
  materializePackagedOmxPluginCache,
  omxPluginCacheBase,
  packagedOmxPluginVersion,
  resolvePackagedOmxMarketplace,
} from "../plugin-marketplace.js";

const packageRoot = process.cwd();

async function withIsolatedUserHome<T>(wd: string, fn: (codexHomeDir: string) => Promise<T>): Promise<T> {
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

describe("issue 3552 stale publication lock recovery", () => {
  it("reclaims an expired malformed publication lock after age fencing", async () => {
    const wd = await mkdtemp(join(tmpdir(), "omx-3552-malformed-lock-age-"));
    try {
      await withIsolatedUserHome(wd, async (codexHomeDir) => {
        const packaged = await resolvePackagedOmxMarketplace(packageRoot);
        assert.ok(packaged);
        const cacheBase = omxPluginCacheBase(codexHomeDir);
        const lockPath = join(cacheBase, ".omx-publish.lock");
        await mkdir(cacheBase, { recursive: true });
        await writeFile(lockPath, JSON.stringify({ pid: "not-a-number", heartbeatAt: "bad" }));
        const expired = new Date(Date.now() - 10 * 60_000);
        await utimes(lockPath, expired, expired);
        const result = await materializePackagedOmxPluginCache(codexHomeDir, packaged);
        assert.equal(result.status, "materialized", JSON.stringify(result));
        assert.equal(existsSync(lockPath), false);
        assert.equal(await hasExpectedOmxPluginCache(codexHomeDir, packaged), true);
        assert.equal(typeof await packagedOmxPluginVersion(packaged), "string");
        assert.equal(await readFile(join(result.cacheDir!, ".omx-complete"), "utf-8").then((value) => value.length > 0), true);
      });
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it("uses inode age when a lock heartbeat is materially in the future", async () => {
    const wd = await mkdtemp(join(tmpdir(), "omx-3552-future-heartbeat-"));
    try {
      await withIsolatedUserHome(wd, async (codexHomeDir) => {
        const packaged = await resolvePackagedOmxMarketplace(packageRoot);
        assert.ok(packaged);
        const cacheBase = omxPluginCacheBase(codexHomeDir);
        const lockPath = join(cacheBase, ".omx-publish.lock");
        await mkdir(cacheBase, { recursive: true });
        await writeFile(lockPath, JSON.stringify({
          pid: 99999999,
          createdAt: Date.now() - 600_000,
          heartbeatAt: Date.now() + 3_600_000,
          processToken: "implausible-future",
        }));
        const expired = new Date(Date.now() - 10 * 60_000);
        await utimes(lockPath, expired, expired);
        const result = await materializePackagedOmxPluginCache(codexHomeDir, packaged);
        assert.equal(result.status, "materialized", JSON.stringify(result));
        assert.equal(await hasExpectedOmxPluginCache(codexHomeDir, packaged), true);
      });
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });
});
