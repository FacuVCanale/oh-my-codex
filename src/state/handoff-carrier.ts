/**
 * One validator for the `handoff_artifacts` carrier, shared by every writer that merges it.
 *
 * Two review generations found the same defect in two different places, and the root cause was that
 * each writer implemented its own normalization: a supplied array or scalar was coerced to `{}` before
 * anything validated it, which erased the difference between "supplied but malformed" and "absent".
 * The completion gate then saw absence, took the permitted advisory path, and forged evidence was
 * laundered into a phase advance.
 *
 * So the rule lives here once and every merge point calls it BEFORE normalizing:
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
 * Read an already-persisted carrier without laundering a corrupt one into a valid-looking record.
 *
 * Returns the record when the stored value is a plain record, and `null` when it is corrupt. Callers
 * must not spread a corrupt value into a fresh object: that is precisely how a persisted array became
 * indistinguishable from a normal empty carrier.
 */
export function readPersistedHandoffCarrier(value: unknown): Record<string, unknown> | null {
  if (value === undefined || value === null) return {};
  if (typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  return null;
}
