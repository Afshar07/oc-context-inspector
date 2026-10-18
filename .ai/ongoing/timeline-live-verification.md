# Reviewer timeline: live-session verification

The timeline and descendant-session discovery are implemented and unit-tested; their design lives in `architecture.md` and `invariants.md`. This task is only the check that needs a real interactive OpenCode session (the E2E cannot drive the TUI).

Run `/context-analyze` in a session that used a lead agent, at least one subagent (ideally one that read no context file) and a test command, and log the built timeline once. Confirm:

1. A tool part's `id` equals the hook's `callID` (otherwise reads silently stay plain tool lines, see `readKey` in `src/analysis.ts`).
2. `ctx.client.session.list({ parentID })` returns the subagent, and a nested one if delegation allows it; `message.sync` works for child session ids.
3. Edit-like tools use `path`/`filePath`; which tool or message type carries shell commands and whether it exposes an exit code.
4. `time.created` of tool parts orders correctly against the other sessions' steps.

Record the outcome here, adjust `src/tui/timeline.ts` / `src/tui/descendants.ts` if an assumption fails, then delete this file and its entry in `README.md`.
