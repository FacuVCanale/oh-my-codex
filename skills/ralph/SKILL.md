---
name: ralph
description: Sunset stub — use $ultragoal instead
---

# Ralph — removed

`$ralph` was removed in OMX 0.21; use `$ultragoal` instead.

Ralph's loop-until-done behavior is a degenerate single-goal ultragoal run. `$ultragoal` owns durable Codex goal handoffs, `.omx/ultragoal` ledger checkpoints, implementation, tests, build/lint/typecheck evidence, and resume across stories. A single-goal ultragoal run reuses the same persistence and verified-completion promise that Ralph provided.

Migration: replace `$ralph` with `$ultragoal`.

Task: {{ARGUMENTS}}
