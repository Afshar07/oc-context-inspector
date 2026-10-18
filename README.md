# opencode-context-inspector

OpenCode **V2** plugin (`@opencode/plugin@2.0.32`, tested on `opencode` CLI `2.0.32`) that records which
project-context files an agent explicitly reads, and shows it in the terminal UI. Observation only: it registers
`ctx.tool.hook` and `ctx.session.hook` callbacks that read events and never write to `input`, `result`, `error`
or the model context.

It has two halves:

* **server** (`index.ts`): records reads to JSONL and serves them over a plugin RPC (`context-inspector`).
* **terminal UI** (`tui.ts`): a sidebar section and a preview panel that call that RPC.

## What is recorded

One JSON line per explicit `read` of a context file, in `<project>/.opencode/context-inspector/<sessionID>.jsonl`:

```json
{"sessionID":"ses_…","callID":"call_…","tool":"read","filePath":".ai/architecture.md","matchedPattern":".ai/**","requestedRange":{"offset":10,"limit":20},"status":"completed","startedAt":"…","completedAt":"…","agentID":"build","messageID":"msg_…","lineage":"root","delivered":{"source":"header","lineCount":20,"range":{"start":10,"end":29},"reachedEof":false},"fileAtRead":{"mtimeMs":1767225600000,"sizeBytes":4096}}
```

Failed reads have `"status":"error"` plus a message truncated to 200 chars. File contents are never stored.
Records are written when the call finishes, so a call that never reaches `execute.after` (e.g. process
killed mid-read) leaves no record.

The fields after `completedAt` are optional; records written by earlier versions simply lack them and keep working.

| field | meaning |
| --- | --- |
| `agentID`, `messageID` | the `agent` and `messageID` OpenCode reports on the tool hooks. Absent when not reported |
| `lineage`, `parentSessionID` | `root` for a lead session; `child` plus the spawning session for a subagent. From `session.get`; absent when that lookup failed (never guessed) |
| `delivered` | the lines the tool actually returned, read from the result's `Read file X, lines A-B` header (or a paged result's `offset`). Numbers only. `reachedEof` / `fileLines` say whether the read hit the end of the file and how long the file was then |
| `fileAtRead` | the file's mtime and size just before the read, so later coverage can tell whether the file changed |

### Sessions

Every session the plugin sees run (a model request or any tool call) gets a small marker,
`<dataDir>/sessions/<sessionID>.json`, written once. So a session that read no context file is still known, and the
project review reports "2 of 10 sessions read this file", not "2 of 2". `<dataDir>/tracking.json` records when tracking
began. Sessions from before that, which only exist as read records, are labelled *reads only*: older sessions that read
nothing are missing from the data, and the review says its ratios for that period are overstated.

## Terminal UI

**Sidebar — "Context files".** Files matching `contextPaths` in the project, plus any missing file the session
tried to read, with what the current session read of it. Updates live as the agent reads (including reads by its
subagents). Unread files are hidden by default; `/context-unread` toggles them (remembered across restarts).

```
Context files
2/3 read
◐ .ai/architecture.md  L10–39/60 · 3× · +1 sub
✕ .ai/missing.md       missing
● AGENTS.md            2×
1 unread hidden · /context-unread
```

| glyph | meaning |
| --- | --- |
| `●` | every line was read |
| `◐` | some lines were read (`L10–39/60`, or `45/120 lines` for several ranges) |
| `○` | not read |
| `◌` | not read explicitly, but OpenCode injects it into the prompt itself (`autoLoaded`) |
| `✕` | only failed reads |
| `?` | reads succeeded but what they covered cannot be told (e.g. the file was deleted and the read left no delivery record) |

`N×` is the number of successful reads. `changed` / `deleted` mean the file was modified or removed after its last read;
the ranges then describe the file as it was read, measured against its size at that time. `~` marks a range that is only
the *requested* one because the read left no delivery record (older data). `+N sub` counts reads by subagents of this
session; they do not change the status, because the lead's context holds what the lead read itself.

**Preview panel.** Opens in the session panel and shows the file *as it is now*: lines the agent read are marked
with `▌` and highlighted, the rest are dimmed. It follows new reads live. `esc` closes it while focused.
File contents are read on demand for display and never written anywhere. A warning line appears when the text may not
be what the agent received (file changed, deleted, or ranges only estimated), and each agent that read the file is
listed under the title:

```
build (lead) · 3× · L10–39 · 1 repeated by itself
explore (subagent) · 1× · L10–29 · 1 repeated after handoff
```

*Repeated by itself*: the agent re-read lines it had already received. *Repeated after handoff*: it read lines another
agent (the lead, a subagent, or an earlier agent of the same session) had already received.

**Opening a preview:**

* click a file in the sidebar;
* `/context` (also in the command palette): pick from a list of all context files, unread included;
* `/context-browse`: select in the sidebar with `↑`/`↓` (or `k`/`j`), `enter` to preview, `esc` to stop.

## Model analysis

Two commands ask a model to interpret the recorded reads. Each first asks which model to use (a searchable list of
your models; "Default (from config)" uses `analysis.model`, or OpenCode's default model; the last pick is
remembered; `esc` cancels). The answer opens in the session panel
(`r` reruns, `esc` closes) and its footer names the model that ran. Both use `ctx.generate.text`, so they run outside
the conversation and do not change it.

* `/context-analyze`: **this session.** Did the agent read the context its task needed, what did it skip, and which
  reads look irrelevant? The task is the session's user messages. Reads by subagents are listed per agent.
* `/context-review`: **all known sessions in the project**, zero-read ones included, split by lead and subagent
  sessions. Which files or sections are never or rarely read, which are only partly read (candidates to split or
  trim), and a short list of concrete edits. The prompt states how many sessions were observed and how many are older
  reads-only sessions, so the model does not over-trust the ratios.

**Acting on a review: `n` in the panel** opens a follow-up session where an agent can make the changes:

* after `/context-analyze` it **forks** the analyzed session, so the agent has the full conversation and task;
* after `/context-review` it starts a **new** session in the project (no history; the review names the files).

The review (plus, for a session analysis, the list of what was read) is added as a **queued** message: nothing runs
until you type an instruction, and the agent then receives the review first and your instruction second. It has the
normal tools and permissions of any session, so it can read and edit files.

What is sent to the model: read metadata (status, line ranges, counts; per section, whether it was fully, partly or
not read, or in how many sessions) plus each context file's **outline**: its Markdown headings with line numbers.
File bodies are **not** sent unless `analysis.includeContent` is on. With it on, unread files reach the model provider
even though the agent never read them. Contents are capped at 8,000 characters per file (truncation marker included)
and 40,000 characters in total for everything the content blocks add to the prompt (fences and markers included).
Files are served in path order after all of them are loaded, so which file gets cut never depends on timing.

## Options

| option | default | meaning |
| --- | --- | --- |
| `contextPaths` | `["AGENTS.md", ".ai/**"]` | globs relative to the project; a pattern without `/` matches that basename at any depth; `dir/**` also matches `dir` itself |
| `tools` | `["read"]` | tools to inspect |
| `dataDir` | `.opencode/context-inspector` | output directory (relative to the project) |
| `autoLoaded` | `["AGENTS.md"]` | project-relative files OpenCode injects on its own; shown as `◌` instead of unread |
| `analysis.model` | your default model | the "Default (from config)" choice in the model picker, as `provider/model` or `provider/model#variant` |
| `analysis.includeContent` | `false` | also send file contents to the model, not just heading outlines |

## Install

Local directory in `opencode.jsonc` (a root `index.ts` is required for directory plugins; the root `tui.ts` is picked
up as the terminal-UI half):

```jsonc
{ "plugins": [{ "package": "/path/to/opencode-context-inspector", "options": { "contextPaths": ["AGENTS.md", ".ai/**", "docs/context/**"] } }] }
```

## Develop

```
npm install
npm run typecheck && npm test
npm run e2e -- /path/to/opencode2     # real OpenCode sessions with a scripted LLM (see below)
```

## Scope notes

* Only explicit tool reads are seen. Instructions OpenCode injects on its own (e.g. auto-loaded `AGENTS.md`)
  do not go through the tool hooks and are not recorded.
* The `read` tool's V2 arguments are `path`, `offset`, `limit` (verified from live hook events); `filePath`
  is also accepted. `offset`/`limit` are stored exactly as requested.
* **Coverage uses what the tool returned.** `execute.after` carries the tool result; its first line states the lines
  delivered (`Read file X, lines 30-39`, or `, 0 lines` for an empty file), and paged results add `offset`/`next`/`truncated`.
  That is stored and preferred. Only a record without it (written by an earlier version, or a result in an unrecognised
  format) falls back to the requested range, assuming the V2 `read` tool's semantics (1-based `offset`, `limit` capped
  at 2000), and the coverage is then labelled estimated (`~`). A whole-file read is *not* capped at a page: the tool
  returned all 2,500 lines of a 2,500-line file in the e2e test.
* **Changed and deleted files.** A read is matched to the file by the mtime and size it had just before the read. Only
  reads of the file's current version count toward its current coverage. If every read predates a change or deletion,
  coverage is reported *as read* (against the size the tool reported then: a deleted file whose whole content was read
  is `●` + `deleted`), or `?` when that size is unknown. A file's current line count is never used to judge a file
  that is gone. OpenCode gives no content hash, so a change that keeps both mtime and size is invisible.
* **Attribution** comes from the `agent` field of the tool hooks and `session.get().parentID`. A subagent is a child
  *session*, so "lead" and "subagent" are properties of the session; an agent switch inside one session shows as a
  second agent of the same session. If the lookup fails the lineage stays unknown rather than guessed. A session's
  status counts only its own reads; reads of the sessions below it are listed per agent.
* The preview shows the current file. If it changed after the read, highlighted lines may not be what the agent saw;
  the warning line says so.
* OpenCode compiles `.tsx` with its Solid transform only outside `node_modules`, so the TUI half works as a local
  directory plugin. Publishing it as an npm package would need the TUI precompiled first.
* Analysis answers render a Markdown subset (headings, lists, bold, italic, code). OpenTUI's own `<markdown>` needs
  `@opentui/core`, which OpenCode does not provide to plugins; importing it loads a second copy and the TUI half fails.
* Section outlines come from Markdown `#` headings. A file without headings is one section, so analysis can only say
  which line ranges of it were read. Section counts map reads to the file's *current* headings.
* Not implemented: an agent-facing tool that lets the agent query its own context coverage. It would change agent
  behaviour, and this plugin otherwise only observes.

### Compatibility and migration

Nothing needs migrating. Existing `<sessionID>.jsonl` files are read as before; their records lack the new optional
fields, so their coverage is labelled estimated and their sessions *reads only*. New data is written next to them
(`sessions/`, `tracking.json`). Downgrading is safe: older versions ignore the new fields and files. The RPC gained
fields (`tracking`, `certainty`, `agents`, …), so update the server and TUI halves together.

## E2E test

`e2e/run.sh /path/to/opencode2` runs five real `opencode run` sessions concurrently (plus the subagent one of them
spawns) against a copy of `e2e/project` with the plugin loaded, then asserts what was recorded (`e2e/assert.mjs`, then
`test/e2e-output.test.ts` for coverage and analysis on the real data). It exits nonzero if a session fails to run or any
assertion fails, and always removes its temporary directory (`E2E_KEEP=1` keeps it for inspection). It picks a free port
and gives every session its own OpenCode state. OpenCode, its `read` tool, subagent delegation and the plugin loader are
real; **only the LLM is a scripted OpenAI-compatible stub** (`e2e/mock-llm.mjs`), so no credentials are needed.

| session | script | checks |
| --- | --- | --- |
| A | `AGENTS.md` twice, `.ai/architecture.md` 10+20 twice and 30+10, a missing file, `src/app.ts` | repeats kept as separate records, failed read recorded as `error`, non-context path excluded, delivered ranges |
| B | `.ai/style.md` limit 5, `AGENTS.md` offset 2 | concurrent sessions stay isolated |
| C | empty file, offset past the end, a 2500-line file whole / last page / offset 0 | empty file, failed read, delivered range beyond the 2000-line page |
| D | answers without any tool call | a zero-read session is still observed |
| E → S | E delegates to a subagent, which reads | subagent attribution, `parentSessionID`, original call IDs |

Limitations: OpenCode's stock subagents cannot spawn further agents, so nested delegation is covered by unit tests
only. The terminal UI is covered by unit tests of its formatting and data logic, not by the E2E.

CI (`.github/workflows/ci.yml`) runs `npm ci`, typecheck and unit tests, then this E2E on Linux against the pinned
`@opencode/cli@2.0.32`. The E2E job fails (it is never skipped) if that binary cannot be installed or does not report
the pinned version, and its summary states what the E2E does not cover.
