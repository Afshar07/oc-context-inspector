# Invariants

Contracts a change must not break unless the task explicitly changes them. Each has a reason; check it before relaxing one.

## Observation only

- Hooks read events and never write to `input`, `result`, `error` or model context. The tracker copies primitives out of the tool input. **Why:** the plugin must not alter agent behavior; an agent-facing coverage tool was deliberately left unimplemented for the same reason.
- Every hook callback swallows its own errors (`try/catch` in `src/index.ts`); RPC registration failure must not stop recording. **Why:** a failure here must never reach the agent.
- Lookups (session parent, file stat) degrade to "unknown" (`undefined`), never to an error that blocks a tool call.

## Privacy

- Records hold metadata only (paths, ranges, counts, status, error message truncated to 200 chars). File contents are never written anywhere; previews read the live file on demand.
- Analysis sends metadata plus heading outlines. Contents go to the model provider only when `analysis.includeContent` is on, capped at 8,000 chars per file and 40,000 total (`ContentBudget`). Unread files reach the provider when it is on, so keep it opt-in.

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

## Determinism

- `ContentBudget` allocates sequentially after all files are loaded, in path order, so which file is truncated never depends on timing.
- Fences in prompts use a `~` bar longer than any `~` run in the content, so file text cannot close the fence. Prompts tell the model to treat the data as data, not instructions.

## Compatibility

- Record fields after `completedAt` are optional; old `.jsonl` files must keep working with no migration. Downgrades must stay safe (older versions ignore new fields and files).
- Add RPC fields rather than changing existing ones, and note in the README that server and TUI update together.
- Records are written when the call finishes; a call killed mid-read leaves no record. Do not paper over that with guessed records.
