# oh-my-codex 0.21.0

`0.21.0` is a minor release for the exact range `v0.20.5..0f2bbb704b83f94a69622b1915f555498e0dd283` (99 commits, 310 files, 44 referenced PRs). It is the post-epic consolidation train and intentionally removes deprecated skills and MCP state writer tools, each with an explicit migration error.

## Highlights

- **Removed skills with migration stubs** — 25 removed skills fail fast through a uniform sunset-stub resolver: `$ralph` → `$ultragoal` (the `omx ralph` CLI and ralph persistence runtime are unaffected), `$ultrawork`/`$ecomode`/`$swarm` → `$team`, `$prometheus-strict` → `$plan`, `$review`/`$security-review` → `$code-review`, `$ask-claude`/`$ask-gemini` → `$ask`, `$deepsearch` → `$analyze`, `$frontend-ui-ux` → `$design`, `$visual-verdict`/`$web-clone` → `$visual-ralph`, `$help` → `$omx-setup`; `$tdd`, `$note`, `$trace`, `$build-fix` have no direct replacement (#3506, #3502, #3508).
- **`omx autopilot` canonical orchestrator** — first-class CLI command restoring the staged `$deep-interview` → `$ralplan` → `$ultragoal` chain (#3518, #3517), with Ultragoal ordinary/strict modes and an advisory completion cohort gate in ordinary mode (#3500, #3505).
- **Hard workflow gates removed** — no host-issued consensus receipt is required for workflow transitions; PreToolUse hooks are advisory-only with Codex App capability warnings (#3492, #3497).
- **State single source of truth** — sole-writer state model; the MCP surface is read-only (`state_write`/`state_clear` removed with explicit deprecation errors); stale projections retire through `omx doctor --repair-state`; corrupt or laundered carriers fail closed (#3507, #3498).
- **Bounded plugin lifecycle** — plugin snapshots are bounded with a hook escape hatch; deprecated-skill retirement is keyed to install badges (#3499, #3512).
- **Session authority hardened** — read/write authority split for identity-indeterminate pointers, bounded unproven-pointer adoption, verified-dead pointer quarantine, and team worker provenance verification for external state roots (#3527, #3541, #3528, #3537).

## Fixes / compatibility notes

- Detached `--madmax` root identity on macOS is path-alias canonical and regression-locked (#3550, #3551); the detached tmux owner race retries under an unchanged authority fence (#3540, #3541).
- `omx-runtime` hydrates and is discovered on macOS arm64 npm installs (#3519, #3520).
- URL reader no longer false-truncates at the exact limit (#3546); zero/invalid notification durations are handled (#3544); HUD tolerates Fish `export` (#3480).
- Worker triggers use tmux named `Enter` with Claude 2.1.x prompt detection (#3531); guarded split receipts reject format-string injection (#3489); team scale-down claim-boundary coverage is load-tolerant (#3548, #3549).
- Ralplan → Ultragoal handoff is reachable via user-authorized execution handoff (#3463, #3483); Conductor delegation lanes are unblocked (#3482); workflow/hook recovery contracts are aligned (#3514, #3486).
- Version display prefers `OMX_VERSION_REVISION` (#3417); dependencies: `@biomejs/biome` 2.5.8 (#3532), `@types/node` 26.2.0 (#3485).

> **Upgrade notes for 0.20.x users:** invocations of removed skills now hard-error with the replacement name in the message; MCP clients calling `state_write`/`state_clear` must move to CLI/programmatic state operations; retire stale 0.20.x state projections with `omx doctor --repair-state` (archives under `.omx/archive/`). A 0.20→0.21 upgrade fixture and generator drift tests ship in `npm test` (#3509).

## Compatibility

Minor release with intentional, migration-pathed removals (deprecated skills; MCP state writer tools). Publication, tag, GitHub Release, and npm availability remain pending the owner-authorized promotion lane (issue #3552).

## Contributors

Thanks to Bellman (@Yeachan-Heo) for the majority of commits in this range, with additional contributions from @hiSandog (#3417, #3544, #3546), @jason931225 (#3528), @NagyVikt (#3480), and the gaebal-gajae (clawdbot) release bot, plus @app/dependabot for dependency updates (#3484, #3485, #3532).

**Full Changelog**: [`v0.20.5...v0.21.0`](https://github.com/Yeachan-Heo/oh-my-codex/compare/v0.20.5...v0.21.0)
