import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const testDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(testDir, "..", "..", "..");

function runNode(scriptRelative: string, args: string[] = []): {
	status: number | null;
	stdout: string;
	stderr: string;
} {
	const script = join(repoRoot, scriptRelative);
	const result = spawnSync(process.execPath, [script, ...args], {
		cwd: repoRoot,
		encoding: "utf-8",
		env: { ...process.env },
	});
	return {
		status: result.status,
		stdout: result.stdout || "",
		stderr: result.stderr || "",
	};
}

describe("generated artifact drift checks (C10)", () => {
	it("plugin mirror --check is green on a clean tree", () => {
		const result = runNode("dist/scripts/sync-plugin-mirror.js", ["--check"]);
		assert.equal(result.status, 0, result.stderr || result.stdout);
	});

	it("catalog docs --check is green on a clean tree", () => {
		const result = runNode("dist/scripts/generate-catalog-docs.js", ["--check"]);
		assert.equal(result.status, 0, result.stderr || result.stdout);
	});

	it("prompt-guidance fragments --check is green on a clean tree", () => {
		const result = runNode("dist/scripts/sync-prompt-guidance-fragments.js", ["--check"]);
		assert.equal(result.status, 0, result.stderr || result.stdout);
	});

	it("capabilities lock --check is green on a clean tree", () => {
		const result = runNode("dist/scripts/verify-capabilities-lock.js");
		assert.equal(result.status, 0, result.stderr || result.stdout);
	});

	it("fails when the capabilities lock is stale", () => {
		const lockPath = join(repoRoot, "omx-capabilities.lock.json");
		assert.equal(existsSync(lockPath), true);
		const backupDir = mkdtempSync(join(tmpdir(), "omx-cap-lock-"));
		const backupPath = join(backupDir, "omx-capabilities.lock.json");
		copyFileSync(lockPath, backupPath);
		try {
			const lock = JSON.parse(readFileSync(lockPath, "utf-8")) as {
				surfaces: { skills: { digest: string } };
			};
			lock.surfaces.skills.digest = "intentionally-stale-for-drift-test";
			writeFileSync(lockPath, `${JSON.stringify(lock, null, 2)}\n`);

			const result = runNode("dist/scripts/verify-capabilities-lock.js");
			assert.notEqual(result.status, 0);
			assert.match(`${result.stderr}\n${result.stdout}`, /skill_surface_mismatch|FAIL|capabilities/i);
		} finally {
			copyFileSync(backupPath, lockPath);
			rmSync(backupDir, { recursive: true, force: true });
		}
	});

	it("fails when a prompt-guidance target drifts from fragments", () => {
		const target = join(repoRoot, "templates", "AGENTS.md");
		assert.equal(existsSync(target), true);
		const backupDir = mkdtempSync(join(tmpdir(), "omx-prompt-guidance-"));
		const backupPath = join(backupDir, "AGENTS.md");
		copyFileSync(target, backupPath);
		try {
			const original = readFileSync(target, "utf-8");
			const start = "<!-- OMX:GUIDANCE:OPERATING:START -->";
			const end = "<!-- OMX:GUIDANCE:OPERATING:END -->";
			const startIdx = original.indexOf(start);
			const endIdx = original.indexOf(end, startIdx + start.length);
			assert.ok(startIdx >= 0 && endIdx > startIdx, "operating guidance markers must exist");
			const drifted = `${original.slice(0, startIdx + start.length)}\nDRIFT_INJECTED_BY_TEST\n${original.slice(endIdx)}`;
			writeFileSync(target, drifted);

			const result = runNode("dist/scripts/sync-prompt-guidance-fragments.js", ["--check"]);
			assert.notEqual(result.status, 0);
			assert.match(`${result.stderr}\n${result.stdout}`, /prompt_guidance_fragment_drift|templates\/AGENTS\.md/);
		} finally {
			copyFileSync(backupPath, target);
			rmSync(backupDir, { recursive: true, force: true });
		}
	});
});
