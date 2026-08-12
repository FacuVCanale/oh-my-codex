/**
 * PreToolUse advisory policy (#3497).
 *
 * Workflow/planning hard gates are deleted. PreToolUse may only:
 * 1. Emit advisory systemMessage / additionalContext guidance, or
 * 2. Deny for authority-decreasing cancel interception (exact-session cancel).
 */

import {
  PRETOOLUSE_DENY_ALLOWED_REASONS,
} from "./types.js";

function safeString(value: unknown): string {
  return typeof value === "string" ? value : value == null ? "" : String(value);
}

function safeObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function extractPreToolUseMessage(output: Record<string, unknown>): string {
  const sourceHookSpecificOutput = safeObject(output.hookSpecificOutput);
  return (
    safeString(sourceHookSpecificOutput.permissionDecisionReason).trim()
    || safeString(output.reason).trim()
    || safeString(output.systemMessage).trim()
    || safeString(sourceHookSpecificOutput.additionalContext).trim()
  );
}

function isAllowedCancelDeny(output: Record<string, unknown>): boolean {
  const sourceHookSpecificOutput = safeObject(output.hookSpecificOutput);
  const reason = (
    safeString(sourceHookSpecificOutput.permissionDecisionReason).trim()
    || safeString(output.reason).trim()
  );
  if (PRETOOLUSE_DENY_ALLOWED_REASONS.has(reason)) return true;
  // Handled cancel uses a human-readable reason with cancelled_exact_session token.
  if (reason.includes("cancelled_exact_session")) return true;
  if (reason.includes("OMX direct cancellation")) return true;
  return false;
}

function isDenyOrBlock(output: Record<string, unknown>): boolean {
  const sourceHookSpecificOutput = safeObject(output.hookSpecificOutput);
  return output.decision === "block"
    || sourceHookSpecificOutput.permissionDecision === "deny";
}

/**
 * Convert any PreToolUse deny/block into advisory output, except cancel
 * interception which remains deny so the external cancel command is not double-run.
 */
export function toAdvisoryOrCancelPreToolUseOutput(
  output: Record<string, unknown> | null,
): Record<string, unknown> | null {
  if (!output) return null;

  if (isDenyOrBlock(output) && isAllowedCancelDeny(output)) {
    const sourceHookSpecificOutput = safeObject(output.hookSpecificOutput);
    const reason = extractPreToolUseMessage(output);
    if (!reason) {
      throw new Error(
        "Malformed PreToolUse cancel deny: requires non-empty permissionDecisionReason, reason, or systemMessage.",
      );
    }
    const permissionDecisionReason =
      safeString(sourceHookSpecificOutput.permissionDecisionReason).trim()
      || (reason.includes("cancelled_exact_session") ? "cancelled_exact_session" : reason);
    const additionalContext = safeString(sourceHookSpecificOutput.additionalContext).trim();
    const systemMessage = safeString(output.systemMessage).trim();
    const hookSpecificOutput: Record<string, unknown> = {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason,
    };
    if (additionalContext) hookSpecificOutput.additionalContext = additionalContext;
    return {
      decision: "block",
      reason: safeString(output.reason).trim() || reason,
      ...(systemMessage ? { systemMessage } : {}),
      hookSpecificOutput,
    };
  }

  if (isDenyOrBlock(output)) {
    const message = extractPreToolUseMessage(output);
    if (!message) return null;
    return {
      systemMessage: message,
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        additionalContext: message,
      },
    };
  }

  // Already advisory: keep systemMessage / additionalContext only.
  const systemMessage = safeString(output.systemMessage).trim();
  const sourceHookSpecificOutput = safeObject(output.hookSpecificOutput);
  const additionalContext = safeString(sourceHookSpecificOutput.additionalContext).trim();
  const reason = safeString(output.reason).trim();
  const derived = systemMessage || [reason, additionalContext].filter(Boolean).join("\n\n");
  if (!derived) return Object.keys(output).length === 0 ? {} : null;
  if (systemMessage && !additionalContext && !reason && !sourceHookSpecificOutput.permissionDecision) {
    return { systemMessage };
  }
  return {
    systemMessage: derived,
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      additionalContext: derived,
    },
  };
}

/**
 * Sanitize native hook output so PreToolUse never hard-locks ordinary work.
 */
export function sanitizeNativeHookOutput(
  hookEventName: string | null,
  output: Record<string, unknown> | null,
): Record<string, unknown> | null {
  if (!output || hookEventName !== "PreToolUse") return output;
  return toAdvisoryOrCancelPreToolUseOutput(output);
}
