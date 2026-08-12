import { existsSync } from 'fs';
import { readFile } from 'fs/promises';
import { getAuthoritativeActiveStatePaths } from '../mcp/state-paths.js';
import { readNeutralizedRoutingOverlay } from '../ralplan/documented-leader-preflight.js';

export const TRACKED_WORKFLOW_MODES = [
  'autopilot',
  'autoresearch',
  'team',
  'ultragoal',
  'ralph',
  'ultrawork',
  'ultraqa',
  'ralplan',
  'deep-interview',
] as const;

export type TrackedWorkflowMode = (typeof TRACKED_WORKFLOW_MODES)[number];
export type WorkflowTransitionAction = 'activate' | 'start' | 'write';
export type WorkflowTransitionKind = 'allow' | 'overlap' | 'auto-complete';

const AUTO_COMPLETE_TRANSITIONS = new Set([
  'deep-interview->autopilot',
  'deep-interview->autoresearch',
  'deep-interview->ralph',
  'deep-interview->team',
  'deep-interview->ultragoal',
  'deep-interview->ultrawork',
  'deep-interview->ralplan',
  'ralplan->team',
  'ralplan->ultragoal',
  'ralplan->ralph',
  'ralplan->autopilot',
  'ralplan->autoresearch',
  'ultragoal->ultraqa',
]);

function safeString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function normalizeTrackedModes(modes: Iterable<string>): TrackedWorkflowMode[] {
  const deduped = new Set<TrackedWorkflowMode>();
  for (const mode of modes) {
    if (isTrackedWorkflowMode(mode)) {
      deduped.add(mode);
    }
  }
  return [...deduped];
}

function buildAutoCompleteKey(a: TrackedWorkflowMode, b: TrackedWorkflowMode): string {
  return `${a}->${b}`;
}

function isAutoCompleteTransition(a: TrackedWorkflowMode, b: TrackedWorkflowMode): boolean {
  return AUTO_COMPLETE_TRANSITIONS.has(buildAutoCompleteKey(a, b));
}

export function buildWorkflowTransitionMessage(
  sourceMode: TrackedWorkflowMode,
  requestedMode: TrackedWorkflowMode,
): string {
  return `mode transiting: ${sourceMode} -> ${requestedMode}`;
}

export interface WorkflowTransitionDecision {
  allowed: boolean;
  kind: WorkflowTransitionKind;
  currentModes: TrackedWorkflowMode[];
  requestedMode: TrackedWorkflowMode;
  resultingModes: TrackedWorkflowMode[];
  autoCompleteModes: TrackedWorkflowMode[];
  transitionMessage?: string;
}

export function isTrackedWorkflowMode(mode: string): mode is TrackedWorkflowMode {
  return (TRACKED_WORKFLOW_MODES as readonly string[]).includes(mode);
}

export function evaluateWorkflowTransition(
  currentActiveModes: Iterable<string>,
  requestedMode: TrackedWorkflowMode,
): WorkflowTransitionDecision {
  const currentModes = normalizeTrackedModes(currentActiveModes);

  if (currentModes.includes(requestedMode)) {
    return {
      allowed: true,
      kind: 'allow',
      currentModes,
      requestedMode,
      resultingModes: currentModes,
      autoCompleteModes: [],
    };
  }

  if (currentModes.length === 0) {
    return {
      allowed: true,
      kind: 'allow',
      currentModes,
      requestedMode,
      resultingModes: [requestedMode],
      autoCompleteModes: [],
    };
  }

  const autoCompleteModes = currentModes.filter((mode) => (
    isAutoCompleteTransition(mode, requestedMode)
  ));
  const survivableModes = currentModes.filter((mode) => !autoCompleteModes.includes(mode));

  if (autoCompleteModes.length > 0) {
    return {
      allowed: true,
      kind: 'auto-complete',
      currentModes,
      requestedMode,
      resultingModes: normalizeTrackedModes([...survivableModes, requestedMode]),
      autoCompleteModes,
      transitionMessage: buildWorkflowTransitionMessage(autoCompleteModes[0], requestedMode),
    };
  }

  return {
    allowed: true,
    kind: 'overlap',
    currentModes,
    requestedMode,
    resultingModes: normalizeTrackedModes([...currentModes, requestedMode]),
    autoCompleteModes: [],
  };
}

export async function readActiveWorkflowModes(
  cwd: string,
  sessionId?: string,
): Promise<TrackedWorkflowMode[]> {
  const activeModes: TrackedWorkflowMode[] = [];

  for (const mode of TRACKED_WORKFLOW_MODES) {
    const candidatePaths = await getAuthoritativeActiveStatePaths(mode, cwd, sessionId);
    for (const candidatePath of candidatePaths) {
      if (!existsSync(candidatePath)) continue;
      try {
        const parsed = JSON.parse(await readFile(candidatePath, 'utf-8')) as { active?: unknown };
        const overlay = mode === 'ralplan' ? await readNeutralizedRoutingOverlay(candidatePath, 'ralplan') : null;
        if ((overlay ?? parsed).active === true) {
          activeModes.push(mode);
        }
        break;
      } catch {
        throw new Error(
          `Cannot read ${mode} workflow state at ${candidatePath}. Repair or clear that workflow state yourself via \`omx state clear --input '{"mode":"${mode}"}' --json\`; if explicit MCP compatibility is enabled, \`omx_state.*\` tools are also acceptable.`,
        );
      }
    }
  }

  return activeModes;
}

export function pickPrimaryWorkflowMode(
  currentPrimary: unknown,
  resultingModes: readonly string[],
  fallbackMode: string,
): string {
  const normalizedCurrent = safeString(currentPrimary).trim();
  if (normalizedCurrent && resultingModes.includes(normalizedCurrent)) {
    return normalizedCurrent;
  }
  return resultingModes[0] || fallbackMode;
}
