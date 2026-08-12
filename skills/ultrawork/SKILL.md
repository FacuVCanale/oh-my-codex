---
name: ultrawork
description: Sunset stub — use $team instead
---

# Ultrawork — removed

`$ultrawork` was removed in OMX 0.21; use `$team` instead.

Parallel execution is team's job. `$team` owns worker panes, shared task state, mailbox/dispatch, and coordinated multi-worker lifecycle control. Ultrawork's prompt-only parallel engine added a second authority without a unique runtime.

Migration: replace `$ultrawork` with `$team`.

Task: {{ARGUMENTS}}
