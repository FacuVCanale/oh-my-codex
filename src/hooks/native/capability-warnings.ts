/**
 * Codex App / outside-tmux capability warnings (#3497 / epic #3491 C6).
 *
 * Team-only features require tmux. When tmux is absent, emit a clean capability
 * warning instead of locking PreToolUse or hard-blocking ordinary workflows.
 * Ultragoal and other ordinary-path skills remain available outside tmux.
 */

export const TEAM_TMUX_CAPABILITY_WARNING =
  "Capability warning: `team` features require an attached tmux session. " +
  "This Codex App / native outside-tmux surface cannot run tmux-backed team workers. " +
  "Continue the ordinary path (understand → execute → verify → report) here, " +
  "or launch OMX CLI from an attached tmux shell before using `omx team` / `$team`.";

export const HUD_TMUX_CAPABILITY_WARNING =
  "Capability warning: the tmux HUD runtime is unavailable from Codex App / native " +
  "outside-tmux Bash. SessionStart/HUD context still applies; launch OMX CLI from an " +
  "attached tmux shell only if you need the live tmux HUD.";

export const QUESTION_TMUX_CAPABILITY_WARNING =
  "Capability warning: `omx question` pane return targeting needs tmux. " +
  "From Codex App / native outside-tmux, prefer the native structured question tool " +
  "or ask one concise plain-text question instead of launching `omx question` via Bash.";

export function buildTeamCapabilityWarningMessage(detail?: string): string {
  return detail ? `${TEAM_TMUX_CAPABILITY_WARNING} ${detail}` : TEAM_TMUX_CAPABILITY_WARNING;
}

export function buildHudCapabilityWarningMessage(): string {
  return HUD_TMUX_CAPABILITY_WARNING;
}

export function buildQuestionCapabilityWarningMessage(command?: string): string {
  if (!command) return QUESTION_TMUX_CAPABILITY_WARNING;
  return `${QUESTION_TMUX_CAPABILITY_WARNING} Original command: ${command}`;
}

/** Advisory-only PreToolUse output (never deny / block). */
export function buildAdvisoryPreToolUseOutput(message: string): Record<string, unknown> {
  const systemMessage = message.trim();
  return {
    systemMessage,
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      additionalContext: systemMessage,
    },
  };
}
