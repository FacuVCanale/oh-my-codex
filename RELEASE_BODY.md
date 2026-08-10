# oh-my-codex 0.20.5

`0.20.5` is a patch release for the exact range `v0.20.4..13c08f84cb6c27750b8f5c4a4d5105faad074196` (68 commits, 35 merged PRs). It contains no intentional breaking CLI or package-layout changes.

## Highlights

- **Darwin detached return-to-shell and finalization** — detached launches now bind readiness and metadata to the live pane, retain exact HUD/leader authority through teardown, release attach only after finalization, and exercise the return-to-shell path on macOS (#3472).
- **Session and hook authority** — exact indeterminate bindings are finalized with synchronous directory-capability revalidation; trusted lock inspection is available for diagnostics; identity-indeterminate Stop handling is silent; authorization failures are no longer reinjected (#3416, #3421, #3471, #3472).
- **Ralplan diagnostics and lifecycle** — preflight remains state-preserving, reports structured detected-version diagnostics, clears stale owner-scoped state, permits typed consensus delegation, and recognizes Codex 0.148 alpha versions (#3450, #3455, #3456, #3473).
- **Windows and setup durability** — directory `fsync` `EPERM`, hook mode synthesis, and mode read-back are tolerated on Windows; launch repair preserves user notify/reasoning settings and project scope (#3448, #3449, #3467, #3468).
- **Team/tmux boundaries** — foreign pane topology is explained rather than claimed, and source-authority separator argv boundaries are preserved (#3434, #3460).
- **Plugin/runtime and packed-install fixes** — packed runtime provisioning and cwd checks are deterministic, ambient session state is scrubbed, detached OMX state is bound to launch context, and Doctor validates native process-identity readiness (#3395, #3436, #3454, #3461, #3470).
- **Dependencies** — `windows-sys` 0.59→0.61.2, `tar-stream` 2.2.0→3.2.0, `@types/tar-stream` 2.2.3→3.1.4, `@biomejs/biome` 2.5.4→2.5.6, and `@types/node` 26.1.1→26.1.2 (#3429–#3432).

> **Current status / supersession (ADR 3212):** Local leader attestation and adapted role intent do not authorize. Typed routing and tracker evidence are lifecycle or diagnostic evidence only. When `role_routing_unavailable` applies to an adapted Ralplan authority attempt, installed role-intent and preflight fail closed with `unsupported_documented_leader_proof`. Ralplan consensus remains unavailable with `documented_host_consensus_receipt_unavailable` because no official host receipt verifier exists; native Architect/Critic evidence alone cannot release the transition.

## Compatibility

Patch release with no intentional breaking contract. Publication, tag, GitHub Release, and npm availability remain pending the owner-authorized promotion lane.

## Contributors

Thanks to Bellman (@Yeachan-Heo) for the majority of commits in this range, with an additional contribution from @ev78394, plus @app/dependabot for dependency updates.

**Full Changelog**: [`v0.20.4...v0.20.5`](https://github.com/Yeachan-Heo/oh-my-codex/compare/v0.20.4...v0.20.5)
