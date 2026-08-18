/**
 * One validator for the `handoff_artifacts` carrier, shared by every writer that merges it.
 *
 * The rule must be defined once, because a writer that normalizes a carrier on its own erases the
 * difference between "supplied but malformed" and "absent": the completion gate then reads absence,
 * takes the permitted advisory path, and forged evidence becomes a phase advance. Every merge point
 * calls this BEFORE normalizing:
 *  - `undefined` and `null` are ABSENCE. Explicit null is ordinary JSON for "no value" and keeps the
 *    advisory path, matching how the gate's own `present()` predicate treats it.
 *  - a non-array object is the only valid supplied shape.
 *  - anything else - array, string, number, boolean - is corruption and throws.
 */

/** Is this value an acceptable carrier, i.e. absent or a plain (non-array) record? */
export function isValidHandoffCarrier(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  return typeof value === 'object' && !Array.isArray(value);
}

/**
 * Throw unless `value` is absent or a plain record.
 *
 * `label` names the supplying surface so the operator can tell which payload was rejected, e.g.
 * `state_write state.handoff_artifacts`.
 */
export function assertValidHandoffCarrier(value: unknown, label: string): void {
  if (isValidHandoffCarrier(value)) return;
  const actual = Array.isArray(value) ? 'an array' : `a ${typeof value}`;
  throw new Error(
    `Cannot write Autopilot state with a malformed ${label}; it must be an object, and ${actual} `
    + 'cannot be distinguished from absent evidence once merged.',
  );
}

/**
 * Read an already-persisted carrier, returning `null` when the stored value is corrupt.
 *
 * Deliberately NOT exported. Callers get `requirePersistedHandoffCarrier` instead, because the only
 * thing a caller can do wrong with this function is `?? {}` it - which converts corruption straight
 * back into "valid but empty", since legitimate absence already returns `{}`.
 */
function readPersistedHandoffCarrier(value: unknown): Record<string, unknown> | null {
  if (value === undefined || value === null) return {};
  if (typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  return null;
}

/**
 * Read a persisted carrier, or THROW when the stored value is corrupt.
 *
 * Absence yields `{}`; corruption throws. The distinction is the whole point: coalescing a corrupt
 * read to `{}` would convert corruption back into "valid but empty", since legitimate absence already
 * returns `{}`.
 */
export function requirePersistedHandoffCarrier(value: unknown, label: string): Record<string, unknown> {
  const carrier = readPersistedHandoffCarrier(value);
  if (carrier !== null) return carrier;
  throw new Error(
    `Cannot merge Autopilot state: the stored ${label} is malformed. `
    + 'Run `omx doctor --repair-state` to retire the corrupt projection.',
  );
}

/**
 * Validate EVERY location a carrier can be read from in one payload.
 *
 * `stateField` in the completion gate prefers a top-level `handoff_artifacts` and otherwise falls back
 * to `state.handoff_artifacts`, so validating only the top level left the nested representation as an
 * open door: a malformed nested carrier passed a top-level-only guard and was still what the gate
 * would read. Any writer accepting caller input must call this, not the single-value assertion.
 *
 * The recursion deliberately stops at ONE level of `state`, because that is exactly how far
 * `stateField` looks. A value buried deeper - `state.state.handoff_artifacts` - is unreadable by the
 * gate, so it can never be credited as evidence nor mistaken for absence; it is inert stored junk
 * rather than an authorization bypass. If `stateField` ever gains a level, the paired test
 * `does not let the gate read a carrier this validator ignores` fails and forces this to match.
 */
export function assertValidHandoffCarriersIn(payload: Record<string, unknown>, label: string): void {
  assertValidHandoffCarrier(payload.handoff_artifacts, `${label} handoff_artifacts`);
  const nested = payload.state;
  if (nested !== undefined && nested !== null && typeof nested === 'object' && !Array.isArray(nested)) {
    assertValidHandoffCarrier(
      (nested as Record<string, unknown>).handoff_artifacts,
      `${label} state.handoff_artifacts`,
    );
  }
}
