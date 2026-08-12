---
name: pipeline
description: Sunset stub — use $plan and $team directly instead
---

# Pipeline — removed

`$pipeline` was removed in OMX 0.21.

Pipeline's configurable stage sequencing overlapped `$plan` (planning) and `$team` (execution) without a unique runtime. Use the canonical skills directly: `$plan` for optional planning, `$team` for coordinated parallel execution, `$ultragoal` for durable goal-mode runs.

Migration: replace `$pipeline` with explicit `$plan` and `$team` invocations as the task warrants.

Task: {{ARGUMENTS}}
