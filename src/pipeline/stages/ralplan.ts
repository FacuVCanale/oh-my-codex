/**
 * RALPLAN stage adapter for pipeline orchestrator.
 *
 * Wraps the consensus planning workflow (planner + architect + critic)
 * into a PipelineStage. Produces a plan artifact at `.omx/plans/`.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PipelineStage, StageContext, StageResult } from '../types.js';
import { isPlanningComplete, readPlanningArtifacts } from '../../planning/artifacts.js';
import { isNonCleanReviewVerdict } from '../review-verdict.js';
import {
  runRalplanConsensus,
  type RalplanConsensusExecutor,
  type RalplanExecutionLane,
} from '../../ralplan/runtime.js';
import { getBaseStateDir } from '../../mcp/state-paths.js';

export interface CreateRalplanStageOptions {
  executor?: RalplanConsensusExecutor;
  maxIterations?: number;
  requireNativeSubagents?: boolean;
  selectedExecutionLane?: RalplanExecutionLane;
}

interface ConsensusGateEvidence {
  complete: boolean;
  sequence: ['architect-review', 'critic-review'];
  ralplan_architect_review: Record<string, unknown> | null;
  ralplan_critic_review: Record<string, unknown> | null;
  source: string | null;
  blockedReason: string | null;
  blockedDetails?: string[];
}

/**
 * Create a RALPLAN pipeline stage.
 */
export function createRalplanStage(options: CreateRalplanStageOptions = {}): PipelineStage {
  return {
    name: 'ralplan',

    canSkip(ctx: StageContext): boolean {
      if (hasReviewLoopContext(ctx.artifacts)) {
        return false;
      }
      const planningArtifacts = readPlanningArtifacts(ctx.cwd);
      return isPlanningComplete(planningArtifacts)
        && hasDurableRalplanConsensusEvidence(ctx.cwd, ctx.sessionId);
    },

    async run(ctx: StageContext): Promise<StageResult> {
      const startTime = Date.now();
      try {
        if (options.executor) {
          const runtimeResult = await runRalplanConsensus(options.executor, {
            task: ctx.task,
            cwd: ctx.cwd,
            maxIterations: options.maxIterations,
            sessionId: ctx.sessionId,
            requireNativeSubagents: options.requireNativeSubagents,
            selectedExecutionLane: options.selectedExecutionLane,
          });

          const planningArtifacts = readPlanningArtifacts(ctx.cwd);
          const consensusGate = resolveConsensusGateFromState(ctx.cwd, ctx.sessionId);
          const consensusComplete = consensusGate.complete === true;
          return {
            status: runtimeResult.status === 'completed' && consensusComplete ? 'completed' : 'failed',
            artifacts: {
              ...runtimeResult.artifacts,
              plansDir: planningArtifacts.plansDir,
              specsDir: planningArtifacts.specsDir,
              task: ctx.task,
              prdPaths: planningArtifacts.prdPaths,
              testSpecPaths: planningArtifacts.testSpecPaths,
              deepInterviewSpecPaths: planningArtifacts.deepInterviewSpecPaths,
              planningComplete: runtimeResult.planningComplete,
              stage: 'ralplan',
              runtime: true,
              iteration: runtimeResult.iteration,
              latestPlanPath: runtimeResult.latestPlanPath,
              drafts: runtimeResult.drafts,
              architectReviews: runtimeResult.architectReviews,
              criticReviews: runtimeResult.criticReviews,
              ralplanConsensusGate: consensusGate,
            },
            duration_ms: Date.now() - startTime,
            error: runtimeResult.error ?? (consensusComplete ? undefined : consensusGate.blockedReason ?? 'ralplan_consensus_evidence_missing'),
          };
        }

        const planningArtifacts = readPlanningArtifacts(ctx.cwd);
        const consensusGate = resolveConsensusGateFromState(ctx.cwd, ctx.sessionId);
        const planningComplete = isPlanningComplete(planningArtifacts);
        const consensusComplete = consensusGate.complete === true;

        const completed = planningComplete && consensusComplete;
        const error = completed
          ? undefined
          : consensusGate.blockedReason
            ?? (consensusComplete && !planningComplete
              ? 'ralplan_planning_artifacts_missing_after_consensus'
              : planningComplete && !consensusComplete
                ? 'ralplan_consensus_evidence_missing'
                : 'ralplan_planning_artifacts_missing');

        return {
          status: completed ? 'completed' : 'failed',
          artifacts: {
            plansDir: planningArtifacts.plansDir,
            specsDir: planningArtifacts.specsDir,
            task: ctx.task,
            prdPaths: planningArtifacts.prdPaths,
            testSpecPaths: planningArtifacts.testSpecPaths,
            deepInterviewSpecPaths: planningArtifacts.deepInterviewSpecPaths,
            planningComplete,
            stage: 'ralplan',
            ralplanConsensusGate: consensusGate,
            instruction: consensusComplete
              ? `Run RALPLAN consensus planning for: ${ctx.task}`
              : `Remain in RALPLAN for: ${ctx.task}. Complete Architect then Critic approval before handing off to execution.`,
          },
          duration_ms: Date.now() - startTime,
          error,
        };
      } catch (err) {
        return {
          status: 'failed',
          artifacts: {},
          duration_ms: Date.now() - startTime,
          error: `RALPLAN stage failed: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
    },
  };
}

/**
 * Reads the ralplan consensus gate evidence from persisted state files.
 * The runtime stamps the gate with `complete: true` when architect+critic
 * approve. This is lifecycle evidence only — no host receipt is required.
 */
function resolveConsensusGateFromState(
  cwd: string,
  sessionId?: string,
): ConsensusGateEvidence {
  const baseStateDir = getBaseStateDir(cwd);
  const statePaths = sessionId
    ? [
      join(baseStateDir, 'sessions', sessionId, 'ralplan-state.json'),
      join(baseStateDir, 'ralplan-state.json'),
    ]
    : [join(baseStateDir, 'ralplan-state.json')];

  for (const statePath of statePaths) {
    if (!existsSync(statePath)) continue;
    try {
      const state = JSON.parse(readFileSync(statePath, 'utf-8')) as Record<string, unknown>;
      const gate = state.ralplan_consensus_gate ?? state.ralplanConsensusGate;
      if (gate && typeof gate === 'object') {
        const gateRecord = gate as Record<string, unknown>;
        return {
          complete: gateRecord.complete === true,
          sequence: ['architect-review', 'critic-review'],
          ralplan_architect_review: gateRecord.ralplan_architect_review as Record<string, unknown> | null ?? null,
          ralplan_critic_review: gateRecord.ralplan_critic_review as Record<string, unknown> | null ?? null,
          source: statePath,
          blockedReason: typeof gateRecord.blocked_reason === 'string' ? gateRecord.blocked_reason : null,
          ...(Array.isArray(gateRecord.blocked_details)
            ? { blockedDetails: (gateRecord.blocked_details as unknown[]).filter((d): d is string => typeof d === 'string') }
            : {}),
        };
      }
    } catch {
      // Continue to next path
    }
  }

  return {
    complete: false,
    sequence: ['architect-review', 'critic-review'],
    ralplan_architect_review: null,
    ralplan_critic_review: null,
    source: null,
    blockedReason: 'ralplan_consensus_evidence_missing',
  };
}

function hasDurableRalplanConsensusEvidence(
  cwd: string,
  sessionId?: string,
): boolean {
  return resolveConsensusGateFromState(cwd, sessionId).complete === true;
}

function hasReviewLoopContext(artifacts: Record<string, unknown>): boolean {
  if (typeof artifacts.return_to_ralplan_reason === 'string' && artifacts.return_to_ralplan_reason.trim() !== '') {
    return true;
  }
  if (isNonCleanReviewVerdict(artifacts.review_verdict)) {
    return true;
  }

  const codeReviewArtifacts = artifacts['code-review'];
  if (!codeReviewArtifacts || typeof codeReviewArtifacts !== 'object') {
    return false;
  }

  const reviewArtifacts = codeReviewArtifacts as Record<string, unknown>;
  return (
    (typeof reviewArtifacts.return_to_ralplan_reason === 'string'
      && reviewArtifacts.return_to_ralplan_reason.trim() !== '')
    || isNonCleanReviewVerdict(reviewArtifacts.review_verdict)
  );
}
