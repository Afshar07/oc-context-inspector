# opencode-context-inspector

OpenCode **V2** plugin (`@opencode/plugin@2.0.32`, tested on `opencode` CLI `2.0.32`) that records which
project-context files an agent explicitly reads, and shows it in the terminal UI. Observation only: it registers
`ctx.tool.hook` callbacks that read events and never write to `input`, `result` or `error`.

It has two halves:

* **server** (`index.ts`): records reads to JSONL and serves them over a plugin RPC (`context-inspector`).
* **terminal UI** (`tui.ts`): a sidebar section and a preview panel that call that RPC.

## What is recorded

One JSON line per explicit `read` of a context file, in `<project>/.opencode/context-inspector/<sessionID>.jsonl`:

```json
{"sessionID":"ses_…","callID":"call_…","tool":"read","filePath":".ai/architecture.md","matchedPattern":".ai/**","requestedRange":{"offset":10,"limit":20},"status":"completed","startedAt":"…","completedAt":"…"}
```

Failed reads have `"status":"error"` plus a message truncated to 200 chars. File contents are never stored.
Records are written when the call finishes, so a call that never reaches `execute.after` (e.g. process
killed mid-read) leaves no record.

## Terminal UI

**Sidebar — "Context files".** Files matching `contextPaths` in the project, plus any missing file the session
tried to read, with what the current session read of it. Updates live as the agent reads. Unread files are hidden
by default; `/context-unread` toggles them (remembered across restarts).

```
Context files
2/3 read
◐ .ai/architecture.md  L10–39/60 · 3×
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

`N×` is the number of successful reads; `changed` means the file was modified after its last read.

**Preview panel.** Opens in the session panel and shows the file *as it is now*: lines the agent read are marked
with `▌` and highlighted, the rest are dimmed. It follows new reads live. `esc` closes it while focused.
File contents are read on demand for display and never written anywhere.

**Opening a preview:**

* click a file in the sidebar;
* `/context` (also in the command palette): pick from a list of all context files, unread included;
* `/context-browse`: select in the sidebar with `↑`/`↓` (or `k`/`j`), `enter` to preview, `esc` to stop.

## Model analysis

Two commands ask a model to interpret the recorded reads. The answer opens in the session panel
(`r` reruns, `esc` closes). Both use `ctx.generate.text`, so they run outside the conversation and do not change it.

* `/context-analyze`: **this session.** Did the agent read the context its task needed, what did it skip, and which
  reads look irrelevant? The task is the session's user messages.
* `/context-review`: **all recorded sessions in the project.** Which files or sections are never or rarely read, which
  are only partly read (candidates to split or trim), and a short list of concrete edits.

What is sent to the model: read metadata (status, line ranges, counts; per section, whether it was fully, partly or
not read, or in how many sessions) plus each context file's **outline**: its Markdown headings with line numbers.
File bodies are **not** sent unless `analysis.includeContent` is on. With it on, unread files reach the model provider
even though the agent never read them; contents are capped at 8,000 characters per file and 40,000 in total.

## Options

| option | default | meaning |
| --- | --- | --- |
| `contextPaths` | `["AGENTS.md", ".ai/**"]` | globs relative to the project; a pattern without `/` matches that basename at any depth; `dir/**` also matches `dir` itself |
| `tools` | `["read"]` | tools to inspect |
| `dataDir` | `.opencode/context-inspector` | output directory (relative to the project) |
| `autoLoaded` | `["AGENTS.md"]` | project-relative files OpenCode injects on its own; shown as `◌` instead of unread |
| `analysis.model` | your default model | model for `/context-analyze` and `/context-review`, as `provider/model` or `provider/model#variant` |
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
e2e/run.sh /path/to/opencode2     # two concurrent real OpenCode sessions (see below)
```

## Scope notes

* Only explicit tool reads are seen. Instructions OpenCode injects on its own (e.g. auto-loaded `AGENTS.md`)
  do not go through the tool hooks and are not recorded.
* The `read` tool's V2 arguments are `path`, `offset`, `limit` (verified from live hook events); `filePath`
  is also accepted. `offset`/`limit` are stored exactly as requested.
* Line coverage assumes the V2 `read` tool's semantics: `offset` is 1-based and `limit` defaults to, and is capped
  at, 2000 lines.
* The preview shows the current file. If it changed after the read, highlighted lines may not be what the agent saw;
  the `changed` marker flags this.
* OpenCode compiles `.tsx` with its Solid transform only outside `node_modules`, so the TUI half works as a local
  directory plugin. Publishing it as an npm package would need the TUI precompiled first.
* Analysis answers are shown as plain wrapped text; the model's Markdown is not rendered.
* Section outlines come from Markdown `#` headings. A file without headings is one section, so analysis can only say
  which line ranges of it were read.
* Not implemented: an agent-facing tool that lets the agent query its own context coverage. It would change agent
  behaviour, and this plugin otherwise only observes.

## E2E demonstration

`e2e/run.sh` starts two real `opencode run` sessions concurrently against `e2e/project`. OpenCode, its
`read` tool and the plugin loader are real; **the LLM is a scripted OpenAI-compatible stub**
(`e2e/mock-llm.mjs`) because no model credentials were available when this was built. The stub emits fixed
tool calls, which gives a known ground truth to compare the records with.

Session A made 7 reads: `AGENTS.md`; `.ai/architecture.md` 10+20 twice; `.ai/architecture.md` 30+10;
`.ai/missing.md`; `src/app.ts`; `AGENTS.md` again. Session B read `.ai/style.md` (limit 5) and `AGENTS.md` (offset 2).
Result: 6 records for A (the non-context `src/app.ts` read excluded, the missing file recorded as `error`,
repeats kept as separate records) and 2 for B, each in its own file.
