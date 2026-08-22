import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { dispatchCodexNativeHook } from "../codex-native-hook.js";
import { executeStateOperation } from "../../state/operations.js";

const omxBin = fileURLToPath(new URL("../../cli/omx.js", import.meta.url));

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(value, null, 2));
}

function runOmx(cwd: string, env: NodeJS.ProcessEnv, ...args: string[]) {
  return spawnSync(process.execPath, [omxBin, ...args], {
    cwd,
    encoding: "utf-8",
    env: { ...process.env, ...env },
  });
}

async function withEnv<T>(values: Record<string, string | undefined>, run: () => Promise<T>): Promise<T> {
  const before = new Map(Object.keys(values).map((name) => [name, process.env[name]]));
  try {
    for (const [name, value] of Object.entries(values)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    return await run();
  } finally {
    for (const [name, value] of before) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

describe("issue #3369 Autopilot Ralplan state-machine self-lock", () => {
});
