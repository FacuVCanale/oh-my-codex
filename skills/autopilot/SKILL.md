---
name: autopilot
description: Sunset stub — the fixed hard chain was removed; use direct understand -> execute -> verify -> report
---

# Autopilot — removed

`$autopilot` was removed in OMX 0.21.

Autopilot advertised a fixed hard chain (`$deep-interview -> $ralplan -> $ultragoal (+ $team) -> $code-review -> $ultraqa`) as a mandatory sequence. That chain is gone. The default behavior is now the lightweight workflow documented in `templates/AGENTS.md`:

```text
understand -> execute -> verify -> report
```

- **understand**: read the task and repo. No mandatory interview or plan. If the task is ambiguous or high-risk, you MAY invoke `$plan` (optionally `$plan --interview`) — evidence-driven, never required.
- **execute**: direct tool use. `$team` is an explicit opt-in for genuinely parallel multi-domain work; `$ultragoal` is an explicit opt-in for durable multi-goal runs. Neither is part of a fixed chain.
- **verify**: focused tests proportional to the change. `$code-review` / `$ultraqa` remain explicit opt-ins.
- **report**: concise completion report; no receipts, no consensus artifacts.

Each surviving skill is independently invocable. There is no fixed sequence.

Migration: replace `$autopilot` with the default lightweight workflow above, opting into `$plan`, `$ultragoal`, `$team`, `$code-review`, or `$ultraqa` only when the task warrants it.

Task: {{ARGUMENTS}}
