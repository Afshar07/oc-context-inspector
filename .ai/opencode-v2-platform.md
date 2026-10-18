# OpenCode V2 platform facts

Verified against `@opencode/plugin@2.0.32` and `opencode` CLI `2.0.32` (the pinned pair; CI checks the CLI reports that version). Re-verify before relying on these after any bump.

## Plugin API surface used

- Server: `Plugin.define({ id, setup(ctx) })` from `@opencode/plugin`. Used: `ctx.options`, `ctx.location.directory`, `ctx.tool.hook("execute.before"|"execute.after")`, `ctx.session.hook("context")`, `ctx.session.get`, `ctx.rpc.register`, `ctx.generate.text`, `ctx.model.default`.
- TUI: `Plugin.define` from `@opencode/plugin/tui`. Used: `ctx.ui.slot/panel/dialog/toast/tabs/router`, `ctx.keymap.layer/mode`, `ctx.storage.store`, `ctx.data.session` (`get`, `message.sync/list`), `ctx.client.session` (`fork`, `create`, `update`, `switchModel`, `synthetic`, `list`), `ctx.rpc` client.
- Session hooks: `prompt` fires before the agent loop, for root sessions and subagents alike (live: every e2e session got a `prompt` capture). `context` fires on every model request, not once, and its event carries `messages` (roles), `model` and `agent`; the first request of a new session has no assistant or tool message, a fork or resumed session does. The first sight of a session through `context` is therefore not proof of its start.
- `ctx.generate.text` runs outside the conversation, so analysis never changes the session.

## Tool facts

- The `read` tool's V2 arguments are `path`, `offset`, `limit`; `filePath` is also accepted. `offset` is 1-based, `limit` is capped at 2000 for paged reads. A whole-file read is not capped at a page.
- `execute.after` carries the result; its first line is `Read file X, lines A-B` (or `, 0 lines` for an empty file). Paged results add `offset`/`next`/`truncated`.
- Instructions OpenCode injects itself (auto-loaded `AGENTS.md`) bypass the tool hooks and are never recorded; that is why `autoLoaded` exists.
- A subagent is a child *session*. Lead/subagent are properties of the session; an agent switch inside one session appears as a second agent of that session. Stock subagents cannot spawn further agents.
- Child sessions are listed with `ctx.client.session.list({ parentID, order, limit, cursor })` (paged, `{ data, cursor.next }`; `SessionInfo` carries `parentID` and `agent`). The plugin-facing `ctx.data.session.sync(id)` has no `children` option in its type, though the client store has one; `ctx.data.session.family(id)` only knows sessions already loaded. Discovery therefore uses `client.session.list`.
- Tool call ids are unique only within a session; lead and subagents can share one.

## Build and packaging constraints

- A directory plugin needs a root `index.ts`; root `tui.ts` is picked up as the TUI half.
- OpenCode compiles `.tsx` with its Solid transform only outside `node_modules`. The TUI therefore works as a local directory plugin; publishing to npm would need the TUI precompiled first.
- Do **not** import `@opentui/core` at runtime (e.g. its `<markdown>`): OpenCode does not provide it to plugins, a second copy loads and the TUI half fails. That is why `src/tui/markdown-parse.ts` renders a Markdown subset (headings, lists, bold, italic, code) itself.
- `@opentui/solid`, `effect` and `solid-js` are peer dependencies; `@opentui/core`, `@opencode/theme` are dev-only.

## Known limits (not tracked debt)

- Nested delegation is covered by unit tests only (E2E cannot spawn it).
- `client.session.list({ parentID })` discovery is unit-tested with a fake listing; it has not been exercised live (see `ongoing/timeline-live-verification.md`).
- The TUI is covered by unit tests of its formatting and data logic, not by the E2E.
- Section outlines come from Markdown `#` headings; a headingless file is one section.
