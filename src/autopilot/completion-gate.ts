import { deriveAutopilotChildPhase, normalizeAutopilotPhase, type AutopilotChildPhase } from './fsm.js';
import { assertValidHandoffCarriersIn } from '../state/handoff-carrier.js';
import { inferRunOutcome, inferTerminalLifecycleOutcome } from '../runtime/run-outcome.js';
import { existsSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';

type JsonObject = Record<string, unknown>;

function objectRecord(value: unknown): JsonObject {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : {};
}

function nonEmptyString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function stateField(state: JsonObject, key: string): unknown {
  if (Object.prototype.hasOwnProperty.call(state, key)) return state[key];
  return objectRecord(state.state)[key];
}

function existingRepoArtifact(
  state: JsonObject,
  rawPath: unknown,
  allowedPrefixes: readonly string[],
): boolean {
  const nested = objectRecord(state.state);
  const cwd = nonEmptyString(state.workingDirectory ?? state.cwd ?? nested.workingDirectory ?? nested.cwd);
  const path = nonEmptyString(rawPath);
  if (!cwd || !path) return false;
  const absolute = resolve(cwd, path);
  const rel = relative(resolve(cwd), absolute);
  const allowedRoot = resolve(cwd, '.omx');
  const allowedRel = relative(allowedRoot, absolute);
  return !isAbsolute(rel)
    && rel !== '..'
    && !rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`)
    && !isAbsolute(allowedRel)
    && allowedRel !== '..'
    && !allowedRel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`)
    && allowedPrefixes.some((prefix) => allowedRel.replace(/\\/g, '/').startsWith(prefix))
    && existsSync(absolute);
}

function isCanonicalArtifactPath(
  state: JsonObject,
  rawPath: unknown,
  allowedPrefixes: readonly string[],
): boolean {
  const nested = objectRecord(state.state);
  const cwd = nonEmptyString(state.workingDirectory ?? state.cwd ?? nested.workingDirectory ?? nested.cwd);
  const path = nonEmptyString(rawPath);
  if (!cwd || !path) return false;
  const absolute = resolve(cwd, path);
  const rel = relative(resolve(cwd), absolute);
  const allowedRoot = resolve(cwd, '.omx');
  const allowedRel = relative(allowedRoot, absolute).replace(/\\/g, '/');
  return !isAbsolute(rel)
    && rel !== '..'
    && !rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`)
    && !isAbsolute(allowedRel)
    && allowedRel !== '..'
    && !allowedRel.startsWith('..' + '/')
    && allowedPrefixes.some((prefix) => allowedRel.startsWith(prefix));
}

function assertCanonicalArtifactPath(
  state: JsonObject,
  rawPath: unknown,
  allowedPrefixes: readonly string[],
  evidenceDescription: string,
): void {
  const path = nonEmptyString(rawPath);
  if (path && !isCanonicalArtifactPath(state, path, allowedPrefixes)) {
    throw new Error(`Cannot use out-of-scope artifact path; ${evidenceDescription} must be canonical.`);
  }
}

function hasAnyStringField(value: JsonObject, keys: string[]): boolean {
  return keys.some((key) => nonEmptyString(value[key]).length > 0);
}

function stringField(value: JsonObject, key: string): string {
  return nonEmptyString(value[key]);
}

function isImplementationPhase(phase: AutopilotChildPhase | null): boolean {
  return phase === 'ultragoal' || phase === 'rework' || phase === 'team' || phase === 'ralph';
}

const ALLOWED_ACTIVE_TRANSITIONS: Readonly<Record<AutopilotChildPhase, readonly AutopilotChildPhase[]>> = {
  'deep-interview': ['deep-interview', 'ralplan'],
  ralplan: ['ralplan', 'ultragoal'],
  ultragoal: ['ultragoal', 'team', 'code-review'],
  rework: ['rework', 'team', 'code-review'],
  team: ['team', 'ultragoal', 'rework', 'code-review'],
  ralph: ['ralph', 'code-review'],
  'code-review': ['code-review', 'rework', 'ralplan', 'ultraqa'],
  ultraqa: ['ultraqa', 'ralplan'],
};

function isActiveAutopilotState(state: JsonObject): boolean {
  return state.mode === 'autopilot' && state.active === true;
}

function hasDeepInterviewHandoff(state: JsonObject): boolean {
  const gate = objectRecord(stateField(state, 'deep_interview_gate'));
  const handoffs = objectRecord(stateField(state, 'handoff_artifacts'));
  const artifact = handoffs.deep_interview;
  const status = nonEmptyString(gate.status).toLowerCase();
  if (
    status === 'skipped'
    && gate.skip_authorized_by_user === true
    && nonEmptyString(gate.skip_reason)
  ) {
    return nonEmptyString(gate.source).toLowerCase() === 'user'
      && nonEmptyString(gate.session_id) === nonEmptyString(state.session_id)
      && !Number.isNaN(Date.parse(nonEmptyString(gate.skipped_at)))
      && existingRepoArtifact(state, objectRecord(artifact).spec_path ?? objectRecord(artifact).path, ['specs/', 'context/', 'interviews/']);
  }
  if (status !== 'complete') return false;
  if (!nonEmptyString(gate.rationale)) return false;
  const artifactRecord = objectRecord(artifact);
  const hasArtifact = typeof artifact === 'string'
    ? existingRepoArtifact(state, artifact, ['specs/', 'context/', 'interviews/'])
    : existingRepoArtifact(state, artifactRecord.spec_path ?? artifactRecord.path ?? artifactRecord.artifact_path, ['specs/', 'context/', 'interviews/']);
  return hasArtifact;
}

function approvedReview(value: unknown, role: 'architect' | 'critic'): boolean {
  const review = objectRecord(value);
  const reviewRole = nonEmptyString(review.agent_role ?? review.role).toLowerCase();
  const verdict = nonEmptyString(review.verdict ?? review.recommendation).toLowerCase();
  return reviewRole === role && ['approve', 'approved', 'okay'].includes(verdict);
}

function exactInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) ? value : null;
}

function validIsoTimestamp(value: unknown): boolean {
  const text = nonEmptyString(value);
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(text)
    && !Number.isNaN(Date.parse(text));
}

/**
 * Missing handoff evidence is a skipped gate and therefore advisory. Evidence that is PRESENT but
 * structurally forged is corruption and stays fail-closed: accepting a string where an ordering
 * index is required, or a free-text timestamp where an ISO-8601 instant is required, would let
 * fabricated evidence satisfy the handoff contract. Only fields that exist are validated, so an
 * absent field still routes to the advisory path.
 */
function assertNoForgedRalplanHandoffEvidence(state: JsonObject): void {
  // Explicit null counts as ABSENCE, not corruption: it is ordinary JSON for "no value" and takes the
  // advisory path like a missing key. Only a supplied non-null value of the wrong shape is corruption.
  const present = (value: unknown): boolean => value !== undefined && value !== null;
  const forged: string[] = [];

  // Container shapes are validated BEFORE objectRecord() normalizes them. objectRecord turns a
  // scalar, array, or null into {}, which is indistinguishable from an absent container - so a
  // supplied-but-malformed gate or review would read as "evidence simply missing" and take the
  // advisory path instead of failing closed as corruption. Absent stays advisory; supplied-and-
  // malformed is corruption.
  const requireObjectShape = (value: unknown, label: string): void => {
    if (!present(value)) return;
    if (typeof value !== 'object' || Array.isArray(value)) forged.push(`${label} must be an object`);
  };
  const rawGate = stateField(state, 'ralplan_consensus_gate');
  const rawExecution = stateField(state, 'ralplan_execution_handoff');
  const rawHandoffs = stateField(state, 'handoff_artifacts');
  requireObjectShape(rawGate, 'ralplan_consensus_gate');
  requireObjectShape(rawExecution, 'ralplan_execution_handoff');
  // The artifact carrier matters as much as the gate: a supplied array/scalar here also normalizes to
  // {}, which produced no canonical-path error and fell through to the advisory path.
  requireObjectShape(rawHandoffs, 'handoff_artifacts');
  const handoffMember = objectRecord(rawHandoffs).ralplan;
  if (present(handoffMember) && typeof handoffMember !== 'string') {
    requireObjectShape(handoffMember, 'handoff_artifacts.ralplan');
  }
  const gate = objectRecord(rawGate);
  const execution = objectRecord(rawExecution);
  requireObjectShape(gate.ralplan_architect_review, 'ralplan_architect_review');
  requireObjectShape(gate.ralplan_critic_review, 'ralplan_critic_review');
  const architect = objectRecord(gate.ralplan_architect_review);
  const critic = objectRecord(gate.ralplan_critic_review);
  const requireInteger = (value: unknown, label: string): void => {
    if (present(value) && exactInteger(value) === null) forged.push(`${label} must be an integer`);
  };
  requireInteger(architect.sequence_index, 'architect sequence_index');
  requireInteger(critic.sequence_index, 'critic sequence_index');
  requireInteger(architect.review_cycle ?? architect.iteration, 'architect review_cycle');
  requireInteger(critic.review_cycle ?? critic.iteration, 'critic review_cycle');
  requireInteger(execution.review_cycle, 'execution review_cycle');
  if (present(execution.authorized_at) && !validIsoTimestamp(execution.authorized_at)) {
    forged.push('execution authorized_at must be an ISO-8601 timestamp');
  }
  if (forged.length === 0) return;
  throw new Error(
    'Cannot advance Autopilot from ralplan to ultragoal with forged handoff evidence '
    + `(${forged.join('; ')}); durable planning artifacts, sequential Architect and Critic `
    + 'approvals, and a bound execution handoff are required.',
  );
}

function hasRalplanHandoff(state: JsonObject): boolean {
  const handoffs = objectRecord(stateField(state, 'handoff_artifacts'));
  const ralplan = objectRecord(handoffs.ralplan);
  const gate = objectRecord(stateField(state, 'ralplan_consensus_gate'));
  const execution = objectRecord(stateField(state, 'ralplan_execution_handoff'));
  const planPath = ralplan.plan_path ?? ralplan.prd_path;
  const planExists = existingRepoArtifact(state, planPath, ['plans/']);
  const reviews = approvedReview(gate.ralplan_architect_review, 'architect')
    && approvedReview(gate.ralplan_critic_review, 'critic');
  const architect = objectRecord(gate.ralplan_architect_review);
  const critic = objectRecord(gate.ralplan_critic_review);
  const authorized = execution.authorized === true || execution.authorized_by_user === true;
  const stateSession = nonEmptyString(state.session_id);
  const executionSession = nonEmptyString(execution.session_id);
  const cycle = exactInteger(state.review_cycle)
    ?? exactInteger(critic.review_cycle ?? critic.iteration);
  const executionCycle = exactInteger(execution.review_cycle);
  return gate.complete === true
    && planExists
    && reviews
    && authorized
    && Boolean(stateSession)
    && executionSession === stateSession
    && cycle !== null
    && executionCycle === cycle
    && exactInteger(architect.sequence_index) === 1
    && exactInteger(critic.sequence_index) === 2
    && exactInteger(architect.review_cycle ?? architect.iteration) === cycle
    && exactInteger(critic.review_cycle ?? critic.iteration) === cycle
    && nonEmptyString(architect.session_id) === stateSession
    && nonEmptyString(critic.session_id) === stateSession
    && validIsoTimestamp(execution.authorized_at)
    && nonEmptyString(execution.source).toLowerCase() === 'autopilot'
    && state.active === true
    && normalizeAutopilotPhase(state.current_phase) === 'ultragoal';
}

export function isAutopilotSuccessfulTerminalState(state: JsonObject): boolean {
  const phase = normalizeAutopilotPhase(state.current_phase);
  const runOutcome = inferRunOutcome(state);
  const lifecycleOutcome = inferTerminalLifecycleOutcome(state);
  if (phase === 'failed' || runOutcome === 'failed' || runOutcome === 'cancelled' || runOutcome === 'blocked_on_user') return false;
  if (lifecycleOutcome === 'failed' || lifecycleOutcome === 'blocked' || lifecycleOutcome === 'userinterlude' || lifecycleOutcome === 'askuserQuestion') return false;
  if (phase === 'complete') return true;
  if (runOutcome === 'finish') return true;
  if (lifecycleOutcome === 'finished') return true;
  if (nonEmptyString(state.completed_at)) return true;
  return state.active === false;
}

function urlLooksLikeCi(url: string): boolean {
  return /github\.com\/[^/]+\/[^/]+\/actions\/runs\//i.test(url);
}

function evidenceText(value: JsonObject, keys: string[]): string {
  return keys.map((key) => nonEmptyString(value[key]).toLowerCase()).filter(Boolean).join('\n');
}

function looksLikeUltraqaEvidence(value: JsonObject): boolean {
  return /\bultraqa\b|\bqa[_-]?verdict\b|\bqa[_-]?evidence\b/.test(
    evidenceText(value, ['source', 'artifact_path', 'url', 'review_url', 'qa_url']),
  );
}

function looksLikeCodeReviewEvidence(value: JsonObject): boolean {
  return /\bcode[-_]?review\b|\breview[_-]?verdict\b|\breview[_-]?evidence\b|\breviews\//.test(
    evidenceText(value, ['source', 'artifact_path', 'url', 'review_url', 'qa_url']),
  );
}

function hasCodeReviewLocator(value: JsonObject): boolean {
  const artifactPath = stringField(value, 'artifact_path').toLowerCase();
  const reviewUrl = stringField(value, 'review_url');
  if (artifactPath) return looksLikeCodeReviewEvidence(value);
  return reviewUrl.length > 0 || hasAnyStringField(value, ['thread_id', 'agent_id', 'tool_call_id', 'url']);
}

function hasUltraqaLocator(value: JsonObject): boolean {
  const artifactPath = stringField(value, 'artifact_path').toLowerCase();
  const qaUrl = stringField(value, 'qa_url');
  const url = stringField(value, 'url');
  if (artifactPath) return looksLikeUltraqaEvidence(value) || /\bqa\b/.test(artifactPath);
  return qaUrl.length > 0 || urlLooksLikeCi(url) || hasAnyStringField(value, ['tool_call_id', 'thread_id']);
}

function evidenceLocatorSet(value: JsonObject): Set<string> {
  return new Set(['artifact_path', 'url', 'review_url', 'qa_url', 'thread_id', 'tool_call_id', 'agent_id']
    .map((key) => nonEmptyString(value[key]))
    .filter(Boolean));
}

export function hasCleanCodeReviewEvidence(value: unknown): boolean {
  const verdict = objectRecord(value);
  if (verdict.clean !== true) return false;
  if (nonEmptyString(verdict.stage) !== 'code-review') return false;
  if (nonEmptyString(verdict.recommendation).toUpperCase() !== 'APPROVE') return false;
  if (nonEmptyString(verdict.architectural_status).toUpperCase() !== 'CLEAR') return false;
  if (looksLikeUltraqaEvidence(verdict)) return false;
  const url = nonEmptyString(verdict.url);
  if (url && urlLooksLikeCi(url)) return false;
  return hasCodeReviewLocator(verdict);
}

export function hasCleanUltraqaEvidence(value: unknown): boolean {
  const verdict = objectRecord(value);
  if (verdict.clean !== true) return false;
  if (nonEmptyString(verdict.stage) !== 'ultraqa') return false;
  const source = nonEmptyString(verdict.source).toLowerCase();
  if (source === 'leader' || source.includes('code-review')) return false;
  if (looksLikeCodeReviewEvidence(verdict)) return false;
  if (verdict.skipped === true) {
    return (
      nonEmptyString(verdict.reason).length > 0 || nonEmptyString(verdict.skip_reason).length > 0
    ) && hasUltraqaLocator(verdict);
  }
  return hasUltraqaLocator(verdict);
}

export function hasCleanAutopilotReviewAndQaEvidence(state: JsonObject): boolean {
  const review = objectRecord(stateField(state, 'review_verdict'));
  const qa = objectRecord(stateField(state, 'qa_verdict'));
  if (!hasCleanCodeReviewEvidence(review) || !hasCleanUltraqaEvidence(qa)) return false;
  const reviewLocators = evidenceLocatorSet(review);
  const qaLocators = evidenceLocatorSet(qa);
  for (const locator of reviewLocators) {
    if (qaLocators.has(locator)) return false;
  }
  return true;
}

export interface AutopilotCompletionAdvisory {
  skippedGate: string;
  missingEvidence: string;
  message: string;
}

function advisory(
  skippedGate: string,
  missingEvidence: string,
  message: string,
): AutopilotCompletionAdvisory {
  return { skippedGate, missingEvidence, message };
}

export function validateAutopilotCompletionTransition(
  currentState: JsonObject,
  nextState: JsonObject,
  options: { allowUnknownActivePhaseCompletion?: boolean } = {},
): AutopilotCompletionAdvisory | null {
  // CHOKE POINT for the carrier invariant.
  //
  // Six review generations each found a different writer that laundered a malformed
  // `handoff_artifacts` carrier before this gate ran, because enforcement was distributed across
  // every merge site. Rather than wait for writer number seven, the rule is asserted here: every
  // state transition must pass through this function, so a corrupt carrier in either representation
  // fails closed no matter which writer produced it. Individual writers still validate their own
  // input so the error names the offending payload, but this is the boundary that cannot be bypassed.
  assertValidHandoffCarriersIn(currentState as Record<string, unknown>, 'stored');
  assertValidHandoffCarriersIn(nextState as Record<string, unknown>, 'transition');

  const current = { ...currentState, mode: 'autopilot' };
  const next = { ...nextState, mode: 'autopilot' };
  const currentPhase = deriveAutopilotChildPhase(current);
  const nextPhase = deriveAutopilotChildPhase(next);
  const successfulTerminal = isAutopilotSuccessfulTerminalState(next);

  if (
    successfulTerminal
    && isActiveAutopilotState(current)
    && currentPhase === null
    && options.allowUnknownActivePhaseCompletion !== true
  ) {
    return advisory(
      'autopilot-phase',
      'a valid active Autopilot phase before terminalization',
      'Autopilot terminalized from an unknown active phase; restore a valid phase before relying on the completed run.',
    );
  }
  if (currentPhase === 'deep-interview' && successfulTerminal) {
    return advisory(
      'ralplan',
      'the required deep-interview to ralplan transition',
      'Autopilot completed before the ralplan gate; deep-interview should advance to ralplan first.',
    );
  }
  if (currentPhase === 'deep-interview' && nextPhase === 'ralplan') {
    const handoffs = objectRecord(stateField(nextState, 'handoff_artifacts'));
    const artifact = handoffs.deep_interview;
    const artifactPath = typeof artifact === 'string'
      ? artifact
      : objectRecord(artifact).spec_path ?? objectRecord(artifact).path ?? objectRecord(artifact).artifact_path;
    assertCanonicalArtifactPath(
      nextState,
      artifactPath,
      ['specs/', 'context/', 'interviews/'],
      'the durable completed interview gate and handoff artifact',
    );
  }
  if (currentPhase === 'deep-interview' && nextPhase === 'ralplan' && !hasDeepInterviewHandoff(nextState)) {
    return advisory(
      'deep-interview-handoff',
      'a durable completed interview gate and handoff artifact',
      'Autopilot advanced from deep-interview to ralplan without durable interview completion evidence and a handoff artifact.',
    );
  }
  if (currentPhase === 'ralplan' && successfulTerminal) {
    return advisory(
      'ultragoal',
      'the required ralplan to ultragoal transition',
      'Autopilot completed before the ultragoal gate; ralplan should advance to ultragoal first.',
    );
  }
  if (currentPhase === 'ralplan' && nextPhase === 'ultragoal') {
    const handoffs = objectRecord(stateField(nextState, 'handoff_artifacts'));
    const artifact = handoffs.ralplan;
    const artifactPath = typeof artifact === 'string'
      ? artifact
      : objectRecord(artifact).plan_path ?? objectRecord(artifact).prd_path ?? objectRecord(artifact).path;
    assertCanonicalArtifactPath(
      nextState,
      artifactPath,
      ['plans/'],
      'the durable ralplan handoff artifact',
    );
    assertNoForgedRalplanHandoffEvidence(nextState);
  }
  if (currentPhase === 'ralplan' && nextPhase === 'ultragoal' && !hasRalplanHandoff(nextState)) {
    return advisory(
      'ralplan-handoff',
      'durable planning artifacts, sequential Architect and Critic approvals, and a bound execution handoff',
      'Autopilot advanced from ralplan to ultragoal without durable planning artifacts, sequential approvals, and a bound execution handoff.',
    );
  }
  if (isImplementationPhase(currentPhase) && successfulTerminal) {
    return advisory(
      'code-review',
      'the required implementation to code-review transition',
      `Autopilot completed before the code-review gate; ${currentPhase} should advance to code-review first.`,
    );
  }
  if (isImplementationPhase(currentPhase) && nextPhase === 'ultraqa') {
    return advisory(
      'code-review',
      'a code-review transition before ultraqa',
      `Autopilot skipped the code-review gate from ${currentPhase}; advance to code-review before ultraqa.`,
    );
  }
  if (
    currentPhase
    && nextPhase
    && !ALLOWED_ACTIVE_TRANSITIONS[currentPhase].includes(nextPhase)
  ) {
    return advisory(
      'phase-order',
      `an allowed adjacent transition from ${currentPhase} to ${nextPhase}`,
      `Autopilot advanced from ${currentPhase} to ${nextPhase} outside the allowed phase order (${ALLOWED_ACTIVE_TRANSITIONS[currentPhase].join(', ')}).`,
    );
  }
  if (currentPhase === 'code-review' && successfulTerminal) {
    return advisory(
      'ultraqa',
      'the required code-review to ultraqa transition',
      'Autopilot completed before the ultraqa gate; code-review should advance to ultraqa first.',
    );
  }
  if (currentPhase === 'ultraqa' && successfulTerminal && !hasCleanAutopilotReviewAndQaEvidence(nextState)) {
    return advisory(
      'ultraqa-evidence',
      'clean code-review and ultraqa verdict evidence',
      'Autopilot completed from ultraqa without clean code-review and ultraqa verdict evidence.',
    );
  }
  return null;
}
