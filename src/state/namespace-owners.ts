/**
 * Published owner map for durable `.omx/state/` namespaces (#3498 follow-up).
 *
 * The original "sole writer" claim was that `src/state/operations.ts` is the only module that
 * persists durable state. That claim was false: roughly a dozen production paths write their own
 * projections directly, and the lexical invariant test only recognized one path-construction
 * pattern (`getStateFilename` + `writeFile`), so it never saw them.
 *
 * Rather than migrate every writer — deliberately out of scope, because paths like the multi-file
 * cancel and native hook-cancel transactions carry identity checks, rollback, and atomicity that a
 * naive single-file write would lose — this map states the truth: the **workflow** namespace has one
 * sanctioned writer, and every other namespace has a declared owner.
 *
 * The audit in `src/state/__tests__/single-writer-invariant.test.ts` consumes this map. Adding a new
 * module that writes a `{mode}-state.json` fails that audit until the module is either routed
 * through the sanctioned workflow writer or declared here with a reason. The map is therefore a
 * contract, not documentation: it is only accurate because a test enforces it.
 */

export interface StateNamespaceOwner {
  /** Namespace label used in audit output. */
  namespace: string;
  /** `src`-relative modules permitted to persist state in this namespace. */
  owners: readonly string[];
  /** Why these modules own the namespace, and why they are not the workflow writer. */
  reason: string;
}

/** The single sanctioned writer for workflow-mode projections. */
export const WORKFLOW_STATE_WRITER = 'state/operations.ts';

export const STATE_NAMESPACE_OWNERS: readonly StateNamespaceOwner[] = [
  {
    namespace: 'workflow',
    owners: [
      WORKFLOW_STATE_WRITER,
      'modes/base.ts',
      'state/workflow-transition-reconcile.ts',
    ],
    reason:
      'Workflow-mode projections route through writeStateFile in operations.ts; modes/base.ts and '
      + 'the reconciler call that writer rather than persisting on their own.',
  },
  {
    namespace: 'workflow-companion',
    owners: ['state/skill-active.ts', 'runtime/run-state.ts'],
    reason:
      'skill-active-state.json and run-state.json are derived companions with their own transactional '
      + 'writers; they are not mode projections.',
  },
  {
    namespace: 'session-pointer',
    owners: ['hooks/session.ts'],
    reason:
      'Owns the session pointer and its lock transaction, including quarantine and lineage evidence. '
      + 'Routing it through the workflow writer would discard the pointer-lock protocol.',
  },
  {
    namespace: 'lifecycle-hooks',
    owners: [
      'scripts/notify-hook.ts',
      'scripts/notify-hook/team-worker.ts',
      'scripts/notify-hook/team-leader-nudge.ts',
      'scripts/notify-hook/state-io.ts',
      'scripts/notify-fallback-watcher.ts',
      'scripts/hook-derived-watcher.ts',
      'scripts/codex-native-hook.ts',
    ],
    reason:
      'Hook processes terminalize and nudge projections out-of-band from the agent loop. Declared as '
      + 'acknowledged direct writers; migrating them is explicitly out of scope.',
  },
  {
    namespace: 'cli-lifecycle',
    owners: ['cli/index.ts', 'cli/doctor.ts', 'cli/team.ts', 'team/runtime.ts'],
    reason:
      'Post-launch cleanup, explicit doctor repair archiving, and team shutdown own multi-file '
      + 'transactions whose identity checks and rollback must not be flattened.',
  },
  {
    namespace: 'autoresearch',
    owners: ['autoresearch/runtime.ts'],
    reason: 'Writes autoresearch-state.json at the resolved project root immediately after startMode.',
  },
  {
    namespace: 'team',
    owners: ['team/state.ts', 'team/leader-activity.ts'],
    reason: 'Team namespace owns its own locks, task/worker/dispatch records, and leader activity.',
  },
  {
    namespace: 'hud',
    owners: ['hud/authority.ts', 'hud/reconcile.ts'],
    reason: 'HUD authority state and its locks are a separate domain with their own reconciliation.',
  },
  {
    namespace: 'question',
    owners: ['question/state.ts', 'question/events.ts', 'question/renderer.ts'],
    reason: 'Question records, events, and locks are domain-owned.',
  },
  {
    namespace: 'subagents',
    owners: ['subagents/tracker.ts', 'subagents/role-routing-marker.ts'],
    reason: 'Subagent tracking and routing markers are domain-owned.',
  },
  {
    namespace: 'notifications',
    owners: [
      'notifications/dispatch-cooldown.ts',
      'notifications/idle-cooldown.ts',
      'notifications/lifecycle-dedupe.ts',
      'exec/followup.ts',
    ],
    reason: 'Notification receipts and the follow-up queue are domain-owned sidecars.',
  },
  {
    namespace: 'extensibility',
    owners: ['hooks/triage-state.ts', 'hooks/extensibility/sdk/plugin-state.ts'],
    reason:
      'Prompt-routing triage plus the plugin SDK. The SDK is deliberately open-ended: installed '
      + 'plugins write their own state, so a universal sole-writer claim is impossible by design.',
  },
  {
    namespace: 'test-fixtures',
    owners: ['scripts/smoke-packed-install.ts'],
    reason:
      'Packed-install smoke harness seeds projection fixtures in throwaway trees. It never runs in a '
      + 'user session, but it is declared rather than excluded so the audit stays total.',
  },
  {
    namespace: 'coordination',
    owners: ['mcp/hermes-bridge.ts', 'cli/update.ts', 'cli/star-prompt.ts', 'ralph/persistence.ts'],
    reason: 'Coordination, update cadence, UI prompt, and ralph artifact state.',
  },
];

/** Every module permitted to persist durable state in any declared namespace. */
export function declaredStateWriters(): ReadonlySet<string> {
  return new Set(STATE_NAMESPACE_OWNERS.flatMap((entry) => entry.owners));
}

/** The namespaces a module owns, for audit reporting. */
export function namespacesOwnedBy(srcRelativeModule: string): readonly string[] {
  return STATE_NAMESPACE_OWNERS
    .filter((entry) => entry.owners.includes(srcRelativeModule))
    .map((entry) => entry.namespace);
}
