#!/usr/bin/env node
/**
 * Fail closed when omx-capabilities.lock.json drifts from the live surfaces.
 * Wired into `npm test` (epic #3491 / C10).
 */
import { checkCapabilitiesPreflight } from "../capabilities/lockfile.js";

async function main(): Promise<void> {
	const result = await checkCapabilitiesPreflight({ cwd: process.cwd() });
	if (!result.ok) {
		const detail = result.failures
			.map((failure) => `${failure.code}: ${failure.message}`)
			.join("\n");
		console.error(`capabilities_lock_drift:\n${detail}`);
		process.exit(1);
	}
	console.log(`capabilities lock ok (${result.lockfile})`);
}

main().catch((error) => {
	console.error(error instanceof Error ? error.message : String(error));
	process.exit(1);
});
