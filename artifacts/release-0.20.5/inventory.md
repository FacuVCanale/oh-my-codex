# Release 0.20.5 inventory

- Previous tag: `v0.20.4` (`a62d5bd77bef6d2bc7df467dcae68082b8616239`)
- Frozen candidate: `13c08f84cb6c27750b8f5c4a4d5105faad074196`
- Exact range: `v0.20.4..13c08f84cb6c27750b8f5c4a4d5105faad074196`
- Merge base: `229d5dc4fd82aa87e274ddf22dbe197987f2778e`
- Count: 68 commits; 35 merged PRs
- Classification: patch release; no intentional breaking contract

Reproduce the commit inventory:

```sh
git log --reverse --format='%H%x09%an%x09%s' v0.20.4..13c08f84cb6c27750b8f5c4a4d5105faad074196
```

## Classification

- **Darwin detached return-to-shell/finalization:** live-pane readiness, atomic launch metadata, exact HUD/leader teardown, attach release after finalization, and macOS CI coverage.
- **Session/hook authority:** exact indeterminate binding finalization, synchronous capability revalidation, lock inspection diagnostics, schema-safe Stop behavior, and authorization-failure handling.
- **Ralplan diagnostics/lifecycle:** state-preserving preflight, structured detected-version diagnostics, stale owner-state cleanup, typed consensus delegation, and Codex 0.148 alpha recognition.
- **Windows/setup durability:** directory `fsync` and mode-synthesis tolerance, platform-aware fixtures, and launch-repair preference/scope preservation.
- **Team/tmux boundaries:** foreign topology diagnostics and exact source-authority separator argv preservation.
- **Plugin/runtime/packaging:** deterministic packed runtime/cwd checks, launch-context state binding, native identity readiness, and hermetic smoke behavior.
- **Dependencies:** `windows-sys`, `tar-stream`, `@types/tar-stream`, `@biomejs/biome`, and `@types/node` updates.

## Merged PRs

#3395, #3396, #3401, #3402, #3403, #3404, #3409, #3410, #3413, #3416, #3419, #3421, #3425, #3429, #3430, #3431, #3432, #3434, #3436, #3446, #3448, #3449, #3450, #3453, #3454, #3455, #3456, #3460, #3461, #3467, #3468, #3470, #3471, #3472, #3473.

Associated issue references in commit subjects are not additional PRs.
