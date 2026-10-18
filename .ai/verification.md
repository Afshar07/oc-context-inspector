# Verification

## Commands

| Command | Use |
| --- | --- |
| `npm run typecheck` | `tsc --noEmit`; strict, `noUncheckedIndexedAccess`, covers `index.ts`, `tui.ts`, `src`, `test` |
| `npm test` | `vitest run` (unit tests in `test/`) |
| `npm run e2e -- /path/to/opencode2` | Real OpenCode sessions with a scripted LLM; needs the `opencode2` binary |

Run typecheck and tests for any change in `src/`. Run a single file with `npx vitest run test/<name>.test.ts` while iterating. Run the E2E when the recorded data, tool-result parsing, lineage or hook wiring changed; say so when it was not run (it needs the CLI installed locally).

## Which test covers what

| Area | Tests |
| --- | --- |
| Path matching | `matcher.test.ts` |
| Tracker pairing and records | `plugin.test.ts`, `tracker.test.ts`, `attribution.test.ts` |
| Delivered-range parsing | `delivery.test.ts` |
| Storage and sessions | `store.test.ts`, `sessions.test.ts` |
| Coverage rules, accuracy | `coverage.test.ts`, `accuracy.test.ts` |
| Model prompts, content budget | `analysis.test.ts`, `project-analysis.test.ts` |
| RPC | `rpc.test.ts` |
| TUI logic | `tui.test.ts`, `tui-coverage.test.ts`, `markdown.test.ts`, `handoff.test.ts` |
| Timeline, descendant-session discovery | `timeline.test.ts`, `descendants.test.ts`; read-key joining in `analysis.test.ts` |
| Real E2E output | `e2e-output.test.ts`, `e2e-evaluation.test.ts` (read data produced by `e2e/run.sh`) |
| Revisions: ids, diffs, snapshotter, session classification | `revisions.test.ts`, `session-revisions.test.ts` |
| Experiments: lifecycle, selection, labels, persistence | `experiments.test.ts` |
| Metrics, comparison, evaluation service | `evaluation.test.ts` |
| Reliability: unknown comparability, missing/corrupt anchor snapshots, discovery vs effectiveness, unreadable records | `evaluation-reliability.test.ts` |
| Evaluation RPC schemas, activity summary, plugin wiring | `evaluation-rpc.test.ts`, `plugin-evaluation.test.ts` |
| Experiment TUI logic (formatting, dialogs, keymaps) | `tui-evaluation.test.ts` |

Evaluation tests build a project in a temp dir with `makeHarness` (`test/evaluation-helpers.ts`): real services, no mocks; the snapshotter has no list caching there.

Helpers in `test/helpers.ts`: `MemoryStore`, `StepClock` (deterministic timestamps), `makeTracker`, `withTempDir`. Prefer them over new fakes; the code takes collaborators through constructors (`IContextReadStore`, `IClock`, injected `Generate`, `ITrackerDeps`) so tests need no mocking framework.

## E2E

`e2e/run.sh` copies `e2e/project`, runs six concurrent `opencode run` sessions (A-F plus the subagents S and N) against a free port with isolated OpenCode state, then runs `e2e/assert.mjs` and `test/e2e-output.test.ts`. Only the LLM is faked (`e2e/mock-llm.mjs`, OpenAI-compatible stub). `E2E_KEEP=1` keeps the temp dir. Wave 1 (A-F) is asserted first because later sessions change the counts; then G (edits a context file mid-session, run alone) and H/I/J(+K) (after the change) run, and `e2e-evaluation.test.ts` builds an experiment on the real data. The scenario table lives in the root `README.md`; extend both when adding a scenario.

## CI

`.github/workflows/ci.yml`: `check` (`npm ci`, typecheck, test) then `e2e` on Linux against `@opencode/cli@2.0.32`. The e2e job must fail, not skip, if the binary cannot be installed or reports another version. When bumping `@opencode/plugin`, bump `OPENCODE_CLI_VERSION` in the workflow and the versions in the README together.

## Windows note

The E2E is a bash script run in CI on Linux. Locally on Windows use Git Bash; paths in records and RPC are project-relative POSIX paths, so keep any new path handling normalizing to `/`.
