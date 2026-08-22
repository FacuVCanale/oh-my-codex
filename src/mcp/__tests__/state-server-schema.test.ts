import { describe, it } from "node:test";
import assert from "node:assert/strict";

describe("state-server schema validation", () => {
	it("exposes only read-only state_* tool schemas (MCP surface is read-only per #3498)", async () => {
		process.env.OMX_STATE_SERVER_DISABLE_AUTO_START = "1";
		const { buildStateServerTools } = await import("../state-server.js");

		const tools = buildStateServerTools();
		const names = tools.map((tool: { name: string }) => tool.name).sort();

		// MCP state-server is read-only: only read/list/status tools are advertised.
		// state_write and state_clear are available via CLI parity (buildStateServerWriterTools).
		assert.deepEqual(names, [
			"state_get_status",
			"state_list_active",
			"state_read",
		]);

		assert.equal(
			tools.some((tool: { name: string }) => tool.name.startsWith("team_")),
			false,
		);
	});

	it("exposes writer tool schemas via buildStateServerWriterTools (CLI parity surface)", async () => {
		process.env.OMX_STATE_SERVER_DISABLE_AUTO_START = "1";
		const { buildStateServerWriterTools } = await import("../state-server.js");

		const tools = buildStateServerWriterTools();
		const names = tools.map((tool: { name: string }) => tool.name).sort();

		assert.deepEqual(names, [
			"state_clear",
			"state_write",
		]);
	});

	it("includes deep-interview anywhere mode enums are exposed", async () => {
		process.env.OMX_STATE_SERVER_DISABLE_AUTO_START = "1";
		const { buildStateServerTools } = await import("../state-server.js");

		const tools = buildStateServerTools();
		const toolsWithModeEnum = tools.filter(
			(tool: {
				inputSchema?: { properties?: { mode?: { enum?: string[] } } };
			}) => Array.isArray(tool.inputSchema?.properties?.mode?.enum),
		);

		assert.ok(toolsWithModeEnum.length > 0);
		for (const tool of toolsWithModeEnum) {
			assert.ok(
				tool.inputSchema?.properties?.mode?.enum?.includes("deep-interview"),
			);
		}
	});
});
