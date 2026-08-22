# Release inventory — v0.20.5..dev@0f2bbb70 (issue #3552)

- PREV tag: v0.20.5 = 27b3a91c2ea630c2a82cdbcd45a1f1de30d9bb2a (tagged 2026-08-10)
- Candidate: dev @ 0f2bbb704b83f94a69622b1915f555498e0dd283 (2026-08-22)
- Range: exactly 99 commits (`git log --oneline v0.20.5..0f2bbb70` = 99 lines), 310 files, +31,779/−69,216
- Ancestry: `git merge-base --is-ancestor v0.20.5 0f2bbb70` → OK (verified by leader; inventory lane independently proved via empty reverse range)
- Merge commits: 17, every one carrying a `#NNNN` PR reference — zero unattributed merges, zero direct pushes
- PR references in range subjects: 44 distinct (#3417 #3463 #3480 #3482 #3483 #3484 #3485 #3486 #3489 #3492 #3497 #3499 #3500 #3502 #3505 #3506 #3507 #3508 #3509 #3510 #3512 #3513 #3516 #3517 #3518 #3519 #3520 #3523 #3527 #3528 #3531 #3532 #3533 #3537 #3539 #3541 #3544 #3546 #3547 #3548 #3549 #3550 #3551)
- Window PRs (merged ≥ tag date, 35 total): all 35 map into the range except #3503 #3511 #3524, which were merged outside `dev` (main-only release-train PRs; intentionally excluded)
- Raw artifacts: commits.txt, prs.tsv, merge-map.tsv, range-prs.txt, window-prs.tsv, outside-range-prs.txt in this directory

## PR inventory (range-referenced, grouped by train)

### Epic: skill/planning/execution consolidation (0.21-class)
- #3506 feat/issue-3493 remove deprecated skills (merge 71d2e0f6; commits 8b59cba9 98eccd21 a65635e9 d1e3365c 9adcd5ef 750dc50c df1f771c 57ef0e10 028c91cb)
- #3502 feat/issue-3494 merge planning skills (merge a0a7093e)
- #3508 feat(3495) merge execution loops; remove autopilot/pipeline (0de015be)
- #3500 feat(ultragoal) ordinary/strict modes with advisory cohort gate (875851f4)
- #3505 feat(ultragoal) ordinary/strict modes with advisory cohort gate (c86950a5, squash)
- #3492 fix remove hard workflow gates; authority-decreasing recovery (bd1bdb13)
- #3497 feat simplify hooks; PreToolUse advisory-only; Codex App capability warnings (57abc22f)
- #3513 feat(prompts) centralize invariants and slim prompt architecture (213e2461)
- #3517 feat/issue-3516 restore deep-interview (merge 12b5172f; 01c5db1f)
- #3518 feat(autopilot) restore canonical staged orchestration (8d2adf42)
- #3509 feat(3501) drift tests and upgrade fixture in CI (0e95f63d)

### Epic: state SSOT / lifecycle / authority
- #3507 feat(3498) State SSOT unification — sole writer, read-only MCP, stale neutralization (839b28c9; follow-ups 69449d89 259f5ab6 ee60bb77 4c05f4bd 13fbdfc7 bc3b496c b4b04ad7)
- #3499 feat/issue-3499 slim lifecycle (merge ae903ee1; 126b24fc 2240da1b)
- #3512 fix/issue-3499 bounded snapshot cleanup (merge 81432ce7)
- #3514 fix/issue-3486 canonical contracts (merge dd009ba4; 8442d0f7)
- #3537 fix/issue-3536 external team state root (merge 0555eaf8; 0d6c5414 worker-provenance)
- #3541 fix/issue-3540 detached tmux owner race (merge 18567789; e3c40128)
- #3527 fix(session) recover verified-dead pointers (ce3de586)
- #3528 fix/receipt-authorized-hook-cancel (merge 5ee2193f; 9fbc5051)
- #3482 fix(hooks) unblock Conductor delegation lanes (c4c9ecdf)
- #3489 fix(team) guarded split receipts tmux-safe (986f877a)
- #3463+#3483 fix(ralplan) → ultragoal user-authorized execution handoff (5ef807fd)
- #3548/#3549 test(team) scale-down claim boundary load-tolerant (06652406)

### Fixes / compatibility
- #3550/#3551 madmax detached-root identity regression coverage (merge 0f2bbb70; 99f43e29; train 23295a35 7c53c4d6 3cd2aa2e)
- #3546 fix(url-reader) false truncation at exact limit (merge ddad0cd1; fc1da35d b8af3a75)
- #3547 fix(setup) capability-based wording (b8af3a75)
- #3544 fix(notifications) zero/invalid durations (76552fcd)
- #3531 fix(team) tmux named Enter + Claude 2.1.x prompt detection (0ec1003a)
- #3519/#3520 fix(runtime) omx-runtime hydration on macOS arm64 npm installs (112dc381)
- #3539 (merge 94d54e20), #3532 biome 2.5.8 (merge 3e162d1a), #3533 macOS update (merge 325347e4)
- #3480 fix(hud) Fish export parsing (e2709a4f), #3484 biome 2.5.7, #3485 @types/node
- #3417 fix version-revision fallback (merge 2add27ba)

### Docs-only (internal-only candidates)
- #3523 README gajae-code callout (ee3065be); f45a8529 badge comment docs

## Version decision (G1)

NEXT = **v0.21.0** (leader adjudication on semver-lane CLEAR recommendation):

1. Docs in-range literally say "Removed in OMX 0.21" (docs/skills.html, PR #3506 train) — the range was authored as 0.21.
2. Active+core skills removed ($ralph, $ultrawork, $ecomode, $swarm, $prometheus-strict, $review, $deepsearch, 25 sunset-stub entries) + advertised MCP API surface removed (state_write/state_clear now rejected) — breaking-for-consumers, cannot be 0.20.6.
3. New first-class CLI command `omx autopilot` + new flags (--disable-hooks, --repair-state) — minor-grade additions.
4. Repo precedent: 0.16.0 shipped as "minor release focused on skill deprecation" — same shape as this range.

Adversarial check: "everything is compatible" fails because removed skills hard-error at invocation and removed MCP tools return errors; "patch understates" fails because additions+removals co-occur. Minor is the floor; no major (0.x convention keeps 0.21 for breaking-with-migration-path).
