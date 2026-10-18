<!-- toolkit:sha256=958d45568b77941a5feaf1c30ec0a0c8b3a974dff5dc3c27e334d3cf68726eee -->
# .ai/ - Project Context for AI Agents

At workspace-router step 3, select one route below; defer its documents until
step 7, then follow the route exactly in order.

## Files

| File | Read when you're... |
| --- | --- |
| `ongoing/README.md` | continuing an in-progress task; read only the matching task document |
| `technical-debt/README.md` | locating unresolved technical debt relevant to the current work; read only the matching record |
| `architecture.md` | locating code, tracing the data flow, or changing what is stored on disk or served over RPC |
| `invariants.md` | changing recording, coverage counting, privacy of analysis, or any persisted/RPC field |
| `opencode-v2-platform.md` | touching plugin API calls, the TUI build/packaging, or bumping `@opencode/plugin` |
| `verification.md` | choosing what to run, adding tests or E2E scenarios, or editing CI |

## Rules

- This folder is the local source of truth for AI task context in `oc-context-inspector`.
- Keep file descriptions and task routes updated when project-specific decisions or boundaries change.
- Read only the files selected by the applicable task route or an exact user-named file.

## Task routes

- Continuing in-progress work: `ongoing/README.md` → only the matching task document → source.
- Server-side change (tracker, store, coverage, analysis, RPC): `architecture.md` → `invariants.md` → source → `verification.md`.
- Reviewer timeline or `/context-analyze` change (`src/analysis.ts`, `src/tui/timeline.ts`, `src/tui/descendants.ts`, `src/tui/client.ts`): `architecture.md` (Reviewer timeline) → `invariants.md` → source → `verification.md`.
- Terminal UI change (`src/tui/*`): `architecture.md` → `opencode-v2-platform.md` → source → `verification.md`.
- OpenCode version bump or plugin API change: `opencode-v2-platform.md` → `verification.md` → source.
- Tests, E2E or CI only: `verification.md` → the test or workflow file.
- Route format: `local-context.md` → optional shared/domain context → source.
- When no route applies, inspect the requested source file directly.
