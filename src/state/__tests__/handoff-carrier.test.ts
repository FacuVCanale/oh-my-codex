import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  assertValidHandoffCarrier,
  assertValidHandoffCarriersIn,
  isValidHandoffCarrier,
  requirePersistedHandoffCarrier,
} from '../handoff-carrier.js';

/**
 * The carrier invariant, pinned at the shared definition rather than only through its callers.
 *
 * Five review generations found this same laundering in five different writers, each with its own
 * normalization. These cases exist so the RULE is testable in one place and a new writer can be checked
 * against it directly.
 */
describe('handoff carrier invariant', () => {
  it('treats only absence and plain records as valid supplied carriers', () => {
    for (const valid of [undefined, null, {}, { ralplan: { plan_path: 'p.md' } }]) {
      assert.equal(isValidHandoffCarrier(valid), true, `${JSON.stringify(valid)} must be valid`);
    }
    for (const invalid of [[], ['a'], 'forged', 42, true, false]) {
      assert.equal(isValidHandoffCarrier(invalid), false, `${JSON.stringify(invalid)} must be invalid`);
    }
  });

  it('names the supplying surface when it rejects a carrier', () => {
    assert.throws(
      () => assertValidHandoffCarrier([], 'state_write handoff_artifacts'),
      /state_write handoff_artifacts/,
      'the operator must be told which payload was refused',
    );
    assert.throws(() => assertValidHandoffCarrier('x', 'p'), /a string/);
    assert.throws(() => assertValidHandoffCarrier([], 'p'), /an array/);
  });

  it('validates the nested representation the completion gate falls back to', () => {
    // stateField() prefers a top-level carrier and otherwise reads state.handoff_artifacts, so a
    // top-level-only guard left the nested location as an open door.
    assert.throws(() => assertValidHandoffCarriersIn({ state: { handoff_artifacts: [] } }, 'p'), /state\.handoff_artifacts/);
    assert.throws(() => assertValidHandoffCarriersIn({ state: { handoff_artifacts: 7 } }, 'p'), /state\.handoff_artifacts/);
    assert.throws(() => assertValidHandoffCarriersIn({ handoff_artifacts: [] }, 'p'), /handoff_artifacts/);
    assert.doesNotThrow(() => assertValidHandoffCarriersIn({ handoff_artifacts: {}, state: { handoff_artifacts: {} } }, 'p'));
    assert.doesNotThrow(() => assertValidHandoffCarriersIn({ state: { handoff_artifacts: null } }, 'p'));
    // A malformed `state` container itself is a different concern and must not crash this check.
    assert.doesNotThrow(() => assertValidHandoffCarriersIn({ state: [] }, 'p'));
  });

  it('does not let the gate read a carrier this validator ignores', async () => {
    // The validator stops at one level of `state` because that is how far the gate's stateField()
    // looks. This is not circular: if stateField gains a level, the gate WILL read this array, the
    // gate's own carrier assertion throws, and the advisory expectation below fails - forcing the
    // validator to be extended rather than letting a deeper location become a silent door.
    const { validateAutopilotCompletionTransition } = await import('../../autopilot/completion-gate.js');
    const doubleNested = {
      mode: 'autopilot',
      active: true,
      current_phase: 'deep-interview',
      session_id: 's',
      state: { state: { handoff_artifacts: ['forged'] } },
    };
    // Accepted by the validator precisely because the gate cannot see it...
    assert.doesNotThrow(() => assertValidHandoffCarriersIn(doubleNested, 'p'));
    // ...and the gate therefore reports genuinely absent evidence rather than crediting the array.
    const advisory = validateAutopilotCompletionTransition(
      doubleNested,
      { ...doubleNested, current_phase: 'ralplan' },
    );
    assert.equal(advisory?.skippedGate, 'deep-interview-handoff');
    assert.match(advisory?.missingEvidence ?? '', /.+/, 'the advisory must state what evidence is missing');
  });

  it('distinguishes an absent stored carrier from a corrupt one', () => {
    // Exercised through the public, safe API: the raw reader is module-private precisely so a caller
    // cannot coalesce its corrupt sentinel back into an empty carrier.
    assert.deepEqual(requirePersistedHandoffCarrier(undefined, 'stored'), {});
    assert.deepEqual(requirePersistedHandoffCarrier(null, 'stored'), {});
    assert.deepEqual(requirePersistedHandoffCarrier({ a: 1 }, 'stored'), { a: 1 });
    assert.throws(() => requirePersistedHandoffCarrier([], 'stored'), /malformed/, 'a stored array is corrupt, not empty');
    assert.throws(() => requirePersistedHandoffCarrier('x', 'stored'), /malformed/);
  });

  it('refuses to coalesce a corrupt stored carrier into an empty one', () => {
    // `readPersistedHandoffCarrier(...) ?? {}` is the laundering bug in miniature: absence already
    // returns {}, so the ?? branch fires only for corruption and converts it back to "valid but empty".
    assert.deepEqual(requirePersistedHandoffCarrier(undefined, 'stored'), {});
    assert.deepEqual(requirePersistedHandoffCarrier({ a: 1 }, 'stored'), { a: 1 });
    assert.throws(
      () => requirePersistedHandoffCarrier([], 'handoff_artifacts carrier'),
      /the stored handoff_artifacts carrier is malformed/,
      'the message must name which stored value is corrupt',
    );
    assert.throws(() => requirePersistedHandoffCarrier('x', 'handoff_artifacts carrier'), /doctor --repair-state/);
  });
});
