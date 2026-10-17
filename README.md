# opencode-context-inspector

OpenCode **V2** plugin (`@opencode/plugin@2.0.32`, tested on `opencode` CLI `2.0.32`) that records which
project-context files an agent explicitly reads. Observation only: it registers `ctx.tool.hook`
callbacks that read events and never write to `input`, `result` or `error`.

## What is recorded

One JSON line per explicit `read` of a context file, in `<project>/.opencode/context-inspector/<sessionID>.jsonl`:

```json
{"sessionID":"ses_…","callID":"call_…","tool":"read","filePath":".ai/architecture.md","matchedPattern":".ai/**","requestedRange":{"offset":10,"limit":20},"status":"completed","startedAt":"…","completedAt":"…"}
```

Failed reads have `"status":"error"` plus a message truncated to 200 chars. File contents are never stored.
Records are written when the call finishes, so a call that never reaches `execute.after` (e.g. process
killed mid-read) leaves no record.

## Options

| option | default | meaning |
| --- | --- | --- |
| `contextPaths` | `["AGENTS.md", ".ai/**"]` | globs relative to the project; a pattern without `/` matches that basename at any depth; `dir/**` also matches `dir` itself |
| `tools` | `["read"]` | tools to inspect |
| `dataDir` | `.opencode/context-inspector` | output directory (relative to the project) |

## Install

Local directory in `opencode.jsonc` (a root `index.ts` is required for directory plugins):

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
* Not implemented (by design for this PoC): sidebar, suggestions, AI analysis.

## E2E demonstration

`e2e/run.sh` starts two real `opencode run` sessions concurrently against `e2e/project`. OpenCode, its
`read` tool and the plugin loader are real; **the LLM is a scripted OpenAI-compatible stub**
(`e2e/mock-llm.mjs`) because no model credentials were available when this was built. The stub emits fixed
tool calls, which gives a known ground truth to compare the records with.

Session A made 7 reads: `AGENTS.md`; `.ai/architecture.md` 10+20 twice; `.ai/architecture.md` 30+10;
`.ai/missing.md`; `src/app.ts`; `AGENTS.md` again. Session B read `.ai/style.md` (limit 5) and `AGENTS.md` (offset 2).
Result: 6 records for A (the non-context `src/app.ts` read excluded, the missing file recorded as `error`,
repeats kept as separate records) and 2 for B, each in its own file.
