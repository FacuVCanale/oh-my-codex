import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { spawnSync } from "node:child_process";
import {
  probeInstalledCodexFeatureList,
  probeInstalledCodexVersion,
  probeInstalledCodexVersionDetailed,
} from "../codex-feature-probe.js";

interface SpawnCall {
  command: string;
  args: readonly string[];
  options: {
    encoding?: unknown;
    killSignal?: unknown;
    timeout?: unknown;
    windowsHide?: unknown;
  };
}

describe("codex feature probe", () => {
  it("bounds external Codex CLI probes with a timeout", () => {
    const calls: SpawnCall[] = [];
    const fakeSpawn = ((command: string, args: readonly string[], options: SpawnCall["options"]) => {
      calls.push({ command, args, options });
      return {
        error: undefined,
        output: [],
        pid: 123,
        signal: null,
        status: 0,
        stderr: "",
        stdout: args.includes("--version") ? "codex-cli 0.999.0\n" : "hooks stable true\n",
      };
    }) as unknown as typeof spawnSync;

    assert.equal(probeInstalledCodexFeatureList(fakeSpawn), "hooks stable true\n");
    assert.equal(probeInstalledCodexVersion(fakeSpawn), "codex-cli 0.999.0\n");
    assert.deepEqual(calls.map((call) => [call.command, call.args]), [
      ["codex", ["features", "list"]],
      ["codex", ["--version"]],
    ]);
    for (const call of calls) {
      assert.equal(call.options.encoding, "utf-8");
      assert.equal(call.options.killSignal, "SIGKILL");
      assert.equal(call.options.timeout, 3_000);
      assert.equal(call.options.windowsHide, true);
    }
  });

  it("treats timed-out Codex CLI probes as unavailable", () => {
    const fakeSpawn = (() => ({
      error: Object.assign(new Error("spawnSync codex ETIMEDOUT"), { code: "ETIMEDOUT" }),
      output: [],
      pid: 123,
      signal: "SIGKILL",
      status: null,
      stderr: "",
      stdout: "",
    })) as unknown as typeof spawnSync;

    assert.equal(probeInstalledCodexFeatureList(fakeSpawn), null);
    assert.equal(probeInstalledCodexVersion(fakeSpawn), null);
  });

  it("classifies detailed version probes with timeout-first precedence", () => {
    const timeoutSpawn = (() => ({
      error: Object.assign(new Error("spawnSync codex ETIMEDOUT"), { code: "ETIMEDOUT" }),
      output: [],
      pid: 123,
      signal: "SIGKILL",
      status: null,
      stderr: "",
      stdout: "",
    })) as unknown as typeof spawnSync;
    const unavailableSpawn = (() => ({
      error: Object.assign(new Error("spawnSync codex ENOENT"), { code: "ENOENT" }),
      output: [],
      pid: 0,
      signal: null,
      status: null,
      stderr: "",
      stdout: "",
    })) as unknown as typeof spawnSync;
    const failedSpawn = (() => ({
      error: undefined,
      output: [],
      pid: 123,
      signal: null,
      status: 2,
      stderr: "failed",
      stdout: "",
    })) as unknown as typeof spawnSync;

    assert.deepEqual(probeInstalledCodexVersionDetailed(timeoutSpawn), { status: "timeout" });
    assert.deepEqual(probeInstalledCodexVersionDetailed(unavailableSpawn), { status: "start-unavailable" });
    assert.deepEqual(probeInstalledCodexVersionDetailed(failedSpawn), { status: "exit-failure" });
  });

  it("bounds detailed version output by bytes and lines", () => {
    const oversized = `codex-cli 0.145.0\n${"x".repeat(4_096)}`;
    const fakeSpawn = (() => ({
      error: undefined,
      output: [],
      pid: 123,
      signal: null,
      status: 0,
      stderr: "",
      stdout: oversized,
    })) as unknown as typeof spawnSync;
    const result = probeInstalledCodexVersionDetailed(fakeSpawn);

    assert.equal(result.status, "ok");
    if (result.status !== "ok") return;
    assert.equal(result.collected.truncated, true);
    assert.equal(Buffer.byteLength(result.collected.output, "utf8") <= 4_096, true);

    const nineLinesSpawn = (() => ({
      error: undefined,
      output: [],
      pid: 123,
      signal: null,
      status: 0,
      stderr: "",
      stdout: Array.from({ length: 9 }, (_, index) => index === 0 ? "codex-cli 0.145.0" : `line-${index}`).join("\n"),
    })) as unknown as typeof spawnSync;
    const nineLines = probeInstalledCodexVersionDetailed(nineLinesSpawn);
    assert.equal(nineLines.status, "ok");
    if (nineLines.status !== "ok") return;
    assert.equal(nineLines.collected.lineLimitExceeded, true);
    assert.equal(nineLines.collected.output.split("\n").length, 8);
  });
});
