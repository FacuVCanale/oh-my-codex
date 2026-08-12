import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateWorkflowTransition, TRACKED_WORKFLOW_MODES, type TrackedWorkflowMode } from '../workflow-transition.js';

/**
 * #3492: Authority-decreasing invariant tests.
 *
 * Cancel/clear/recovery must succeed from every reachable workflow state
 * and strictly reduce/deactivate authority. No transition may be denied
 * (no `deny` kind exists in the WorkflowTransitionKind union).
 */

describe('authority-decreasing recovery (#3492)', () => {
  it('never produces a deny transition kind from any single active mode', () => {
    for (const mode of TRACKED_WORKFLOW_MODES) {
      const decision = evaluateWorkflowTransition([mode], 'ralph');
      assert.equal(decision.allowed, true, `${mode} -> ralph should be allowed`);
      assert.notEqual(decision.kind, 'deny', `${mode} -> ralph must not deny`);
    }
  });

  it('never produces a deny transition kind from any pair of active modes', () => {
    const modes = TRACKED_WORKFLOW_MODES;
    for (let i = 0; i < modes.length; i++) {
      for (let j = i + 1; j < modes.length; j++) {
        const current: TrackedWorkflowMode[] = [modes[i], modes[j]];
        const decision = evaluateWorkflowTransition(current, 'autopilot');
        assert.equal(decision.allowed, true, `${current.join(',')} -> autopilot should be allowed`);
        assert.notEqual(decision.kind, 'deny', `${current.join(',')} -> autopilot must not deny`);
      }
    }
  });

  it('allows transitioning to any tracked mode from any single active mode', () => {
    for (const from of TRACKED_WORKFLOW_MODES) {
      for (const to of TRACKED_WORKFLOW_MODES) {
        const decision = evaluateWorkflowTransition([from], to);
        assert.equal(decision.allowed, true, `${from} -> ${to} should be allowed`);
        assert.notEqual(decision.kind, 'deny', `${from} -> ${to} must not deny`);
      }
    }
  });

  it('allows ralplan -> ultragoal without host consensus receipt', () => {
    const decision = evaluateWorkflowTransition(['ralplan'], 'ultragoal');
    assert.equal(decision.allowed, true);
    assert.equal(decision.kind, 'auto-complete');
    assert.deepEqual(decision.autoCompleteModes, ['ralplan']);
    assert.deepEqual(decision.resultingModes, ['ultragoal']);
  });

  it('allows deep-interview -> ralplan without evidence gate', () => {
    const decision = evaluateWorkflowTransition(['deep-interview'], 'ralplan');
    assert.equal(decision.allowed, true);
    assert.equal(decision.kind, 'auto-complete');
    assert.deepEqual(decision.autoCompleteModes, ['deep-interview']);
    assert.deepEqual(decision.resultingModes, ['ralplan']);
  });

  it('allows execution-to-planning rollback (ralph -> ralplan)', () => {
    const decision = evaluateWorkflowTransition(['ralph'], 'ralplan');
    assert.equal(decision.allowed, true);
    assert.notEqual(decision.kind, 'deny');
  });

  it('allows starting a fresh mode from an empty workflow state', () => {
    for (const mode of TRACKED_WORKFLOW_MODES) {
      const decision = evaluateWorkflowTransition([], mode);
      assert.equal(decision.allowed, true);
      assert.equal(decision.kind, 'allow');
      assert.deepEqual(decision.resultingModes, [mode]);
    }
  });

  it('does not define a deny kind in WorkflowTransitionKind', () => {
    // The type itself no longer includes 'deny'. This is a compile-time
    // guarantee; we also assert at runtime that no decision produces it.
    const allKinds = new Set<string>();
    for (const from of TRACKED_WORKFLOW_MODES) {
      for (const to of TRACKED_WORKFLOW_MODES) {
        allKinds.add(evaluateWorkflowTransition([from], to).kind);
      }
    }
    assert.equal(allKinds.has('deny'), false, 'deny kind must never appear');
  });
});
