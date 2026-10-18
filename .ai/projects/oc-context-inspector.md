# oc-context-inspector

## Scope

An OpenCode **V2** plugin (package `opencode-context-inspector`, MIT) that records which project-context files (`AGENTS.md`, `.ai/**`, configurable) an agent explicitly reads, and shows that coverage in the terminal UI. It also asks a model to interpret the reads (`/context-analyze` for one session, `/context-review` across all sessions) and can hand the result to a follow-up session so an agent can fix the context files.

Purpose in one line: help maintainers of agent context see what agents actually read, so they can trim, split or link context files. It observes; it does not steer agents.

Primary project in this workspace. Single package, no sub-projects. Remote: `Afshar07/oc-context-inspector` on GitHub; default working branch `main`.

## Ownership boundaries

- This project owns its implementation details and local conventions.
- Cross-project contracts belong in shared workspace context.
- The plugin only observes explicit tool reads. It must not mutate tool input/results or model context, and must not persist file contents. See `.ai/invariants.md`.
- `.ai/` is managed with `@afshar7/toolkit`; files carrying a `toolkit:sha256` header are toolkit-generated. Prefer adding focused files over rewriting those.

## Where things are

| Need | File |
| --- | --- |
| Module map, data flow, disk layout | `.ai/architecture.md` |
| Rules a change must not break | `.ai/invariants.md` |
| OpenCode V2 facts and packaging limits | `.ai/opencode-v2-platform.md` |
| Commands, test map, E2E, CI | `.ai/verification.md` |
| Behavior, options, record format (user-facing) | root `README.md` |

## History worth knowing

Built incrementally: proof-of-concept recorder -> sidebar pane -> model analysis (`/context-analyze`, `/context-review`) -> model picker plus fork-to-fix follow-up sessions -> more E2E scenarios. Accuracy work (delivered ranges, changed/deleted files, subagent attribution, session tracking) is why coverage distinguishes confirmed, stale and estimated data.
