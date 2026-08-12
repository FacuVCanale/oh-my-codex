import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

/**
 * #3497: ralph-session-resume gating was deleted from notify-hook.
 * notify-hook is notifications / team-dispatch only.
 */
describe("notify-hook ralph-session-resume removal (#3497)", () => {
  it("does not ship ralph-session-resume module", () => {
    const here = fileURLToPath(new URL(".", import.meta.url));
    const modulePath = join(here, "../../scripts/notify-hook/ralph-session-resume.ts");
    assert.equal(existsSync(modulePath), false);
  });
});
