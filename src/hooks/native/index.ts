/**
 * Slim native hook policy modules (#3497 / epic #3491 child C6).
 *
 * SSOT for Codex App / plugin native hook policy:
 * - session bookkeeping
 * - skill-context injection
 * - notifications
 * - advisory PreToolUse guidance
 * - team capability warnings when tmux is absent
 *
 * Workflow hard gates (PreToolUse deny for planning/conductor, evidence-gated
 * transitions) are deleted from this surface.
 */

export * from "./types.js";
export * from "./capability-warnings.js";
export * from "./pre-tool-use-advisory.js";
