import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { cancellationFileIdentityMatches } from "../index.js";

describe("Windows cancellation file identity", () => {
  it("accepts the Windows path-stat versus handle-stat zero-device mismatch", () => {
    assert.equal(
      cancellationFileIdentityMatches(
        { dev: 0, ino: 4242 },
        { dev: 3188088968, ino: 4242 },
        "win32",
      ),
      true,
    );
  });

  it("still rejects inode replacement and nonzero device changes", () => {
    assert.equal(
      cancellationFileIdentityMatches(
        { dev: 0, ino: 4242 },
        { dev: 3188088968, ino: 4343 },
        "win32",
      ),
      false,
    );
    assert.equal(
      cancellationFileIdentityMatches(
        { dev: 11, ino: 4242 },
        { dev: 12, ino: 4242 },
        "win32",
      ),
      false,
    );
    assert.equal(
      cancellationFileIdentityMatches(
        { dev: 3188088968, ino: 4242 },
        { dev: 0, ino: 4242 },
        "win32",
      ),
      false,
    );
  });

  it("does not relax device matching on non-Windows platforms", () => {
    assert.equal(
      cancellationFileIdentityMatches(
        { dev: 0, ino: 4242 },
        { dev: 12, ino: 4242 },
        "linux",
      ),
      false,
    );
  });
});
