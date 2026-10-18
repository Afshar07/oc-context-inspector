# Invariants

Contracts a change must not break unless the task explicitly changes them. Each has a reason; check it before relaxing one.

## Observation only

- Hooks read events and never write to `input`, `result`, `error` or model context. The tracker copies primitives out of the tool input. **Why:** the plugin must not alter agent behavior; an agent-facing coverage tool was deliberately left unimplemented for the same reason.
- Every hook callback swallows its own errors (`try/catch` in `src/index.ts`); RPC registration failure must not stop recording. **Why:** a failure here must never reach the agent.
- Lookups (session parent, file stat) degrade to "unknown" (`undefined`), never to an error that blocks a tool call.

## Privacy

- Records hold metadata only (paths, ranges, counts, status, error message truncated to 200 chars). File contents are never written anywhere; previews read the live file on demand.
- Analysis sends metadata plus heading outlines. Contents go to the model provider only when `analysis.includeContent` is on, capped at 8,000 chars per file and 40,000 total (`ContentBudget`). Unread files reach the provider when it is on, so keep it opt-in.

- The reviewer timeline copies primitives only (tool name, status, project-relative path, truncated error text, exit code). Tool inputs and results, which can carry file contents, are never copied, and the timeline is never persisted. Shell command text reaches the provider only with `analysis.includeContent`, because it may hold secrets and is the only way to tell a test run apart. **Why:** same rule as file contents.

## Never guess

- Lineage (lead/subagent) comes from `session.get().parentID`; if the lookup failed it stays absent.
- Coverage prefers what the tool returned (`delivered`). Only a record without it falls back to the requested range, labelled estimated (`~`, `ECoverageCertainty.Estimated`).
- A file that is changed or deleted since the read is reported *as read* (`Stale`), measured against its size at read time. The current line count is never used to judge a missing file.
- Known blind spot: a change that keeps both mtime and size is invisible (no content hash from OpenCode).

## Counting rules

- A session counts once per file regardless of read count; zero-read sessions stay in the denominator. `sessionsRead` can never exceed `sessionsTotal`.
- A session's status counts only its own reads. Subagent reads are listed per agent (`+N sub`) and do not change the lead's status. **Why:** the lead's context holds only what the lead received.
- Repeats are split: *by itself* (same agent re-read) versus *after handoff* (another agent already received those lines).
- Sessions known only from pre-tracking read records are `reads-only`; reviews must state that their ratios are overstated.

- Tool call ids repeat across sessions (lead and subagents). A read record is identified by `(sessionID, callID)`, never `callID` alone. **Why:** a single-key map let one agent's record overwrite another's and misattributed delivered ranges.
- A session the timeline knows but could not load is reported as unavailable, never silently omitted; the review must not infer that it did nothing.

## Context revisions and experiments

- Evaluation data lives only under `<dataDir>/evaluation/`; read records and session markers are never changed for it. Every file has `version: 1`; a damaged or unknown-version file reads as absent and is left on disk. Writes are atomic (temp file + rename); snapshots are content-addressed and written once.
- Only paths, hashes, sizes, timestamps, model/agent labels and user-typed labels are stored. No prompts, file bodies, credentials or command text. Test-like shell commands are recognized in the TUI and only counts leave it.
- A revision id depends only on sorted project-relative paths and file bytes (code-point order, POSIX separators), never on locale, time or machine. Do not add fields to the hash input without a version bump.
- A session's start revision is established only by a first model request with no assistant/tool turn. Anything first seen later is `Late` and stays unknown; never reconstruct a start. A change seen on a later request makes the session mixed; a mixed or unknown session is never a clean sample.
- No tool call scans the file system. Hooks stay observation-only: events are never written to, and every hook body is wrapped so a failure cannot reach the agent.
- A candidate revision is linked only by explicit confirmation and only if the target files differ from the baseline. Experiments never edit `AGENTS.md`/`.ai/**`, revert anything, or start agents.
- One lead plus its subagents is one sample. Missing evidence (no message log, no delivery info, auto-loaded targets, unlabeled outcomes) is reported as missing, never as zero or failure. Outcome rates use only labels with a note or evidence reference. Efficiency and verification metrics are signals without verdicts.
- A verdict is `inconclusive` when samples are few, evidence is incomplete, models/configuration differ, or other context files changed between the anchor revisions. An overall `improved` names the metrics; it is not a claim about task quality. No AI-generated verdicts.

## Determinism

- `ContentBudget` allocates sequentially after all files are loaded, in path order, so which file is truncated never depends on timing.
- Fences in prompts use a `~` bar longer than any `~` run in the content, so file text cannot close the fence. Prompts tell the model to treat the data as data, not instructions.

## Compatibility

- Record fields after `completedAt` are optional; old `.jsonl` files must keep working with no migration. Downgrades must stay safe (older versions ignore new fields and files).
- Add RPC fields rather than changing existing ones, and note in the README that server and TUI update together.
- Records are written when the call finishes; a call killed mid-read leaves no record. Do not paper over that with guessed records.
