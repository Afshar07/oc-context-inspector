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
subagents). Unread files are hidden by default; `/context-unread` toggles them (remembered across restarts). Click the section title or run `/context-collapse` to
minimize it to one line (`▸ Context files 2/3 read`); that is remembered too, and `/context-browse` expands it again.

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
  reads look irrelevant? The task is the session's user messages. Reads by subagents are listed per agent. The model
  also gets a **timeline** of the session and every subagent it delegated to, nested ones included (user messages,
  tool calls with their status, file paths, shell exit codes, and what each context read delivered), built from
  OpenCode's own message log: nothing extra is recorded. Subagents are found through OpenCode's session listing, so
  one that never read a context file still appears; one whose messages cannot be loaded is listed as unavailable, never
  dropped. Each finding is labelled `context-discovery` (guidance not loaded), `instruction-adherence` (loaded but
  not followed) or `verification-reporting` (claims beyond the evidence), with the triggering action, the quoted
  instruction, whether it was already loaded before that action, a confidence and a remedy. Server and TUI update
  together; an older TUI sends no timeline and the review then says ordering is unknown.
* `/context-review`: **all known sessions in the project**, zero-read ones included, split by lead and subagent
  sessions. Which files or sections are never or rarely read, which are only partly read (candidates to split or
  trim), and a short list of concrete edits. The prompt states how many sessions were observed and how many are older
  reads-only sessions, so the model does not over-trust the ratios.

Press **`e`** in the panel to turn a review into a measured [context experiment](#context-experiments).

**Acting on a review: `n` in the panel** opens a follow-up session where an agent can make the changes:

* `n` starts a **new** session in the project. It has no history, so after `/context-analyze` the first message
  carries a brief: the analyzed session's user messages (capped at 3,000 characters), the review, and what was read.
  After `/context-review` the review names the files. This is the cheap option: the session starts small.
* `f` (after `/context-analyze` only) **forks** the analyzed session, so the agent has the full conversation. Every
  token of that history is sent again with each request, so use it only when the agent must see what happened.

The new session switches to the model you picked for the analysis (the footer's model); with "Default" it keeps the
session's own model.

The review (plus, for a session analysis, the list of what was read) is added as a **queued** message: nothing runs
until you type an instruction, and the agent then receives the review first and your instruction second. It has the
normal tools and permissions of any session, so it can read and edit files.

What is sent to the model: read metadata (status, line ranges, counts; per section, whether it was fully, partly or
not read, or in how many sessions) plus each context file's **outline**: its Markdown headings with line numbers.
The timeline adds tool names, project-relative paths, statuses, short error messages and exit codes; shell command
text is sent only when `analysis.includeContent` is on.
File bodies are **not** sent unless `analysis.includeContent` is on. With it on, unread files reach the model provider
even though the agent never read them. Contents are capped at 8,000 characters per file (truncation marker included)
and 40,000 characters in total for everything the content blocks add to the prompt (fences and markers included).
Files are served in path order after all of them are loaded, so which file gets cut never depends on timing.

## Context experiments

Reviews suggest documentation changes. **Context experiments** measure whether a change you make helps: they compare
how agents behaved before and after, using only what the plugin can observe. The workflow is
**observe → analyze → propose → approve → measure → compare**; the plugin does the measuring and never the editing.
It does not change documentation, run agents, commit, roll back, or call a model for a verdict. You edit the context
files yourself or through your normal agent workflow.

### Context revisions

The plugin fingerprints the tracked context files (`contextPaths`) with SHA-256, locally, and combines the
fingerprints, sorted by project-relative path, into a **revision id** (16 hex characters). It needs no Git. The same
files always give the same id, whatever order or machine they are on; any change to a file's bytes, or adding,
deleting or renaming a file, gives a new one. Only paths, hashes and sizes are stored, never contents.

Each session is tied to the revision in place when it began:

* A session is **stable** when its starting revision is known and the context did not change while it ran.
* **mixed** when the context changed during it (for example the agent edited `AGENTS.md`), or when a subagent ran under
  a different revision than its lead. Mixed sessions are never used as clean before/after samples.
* **unknown** when the start cannot be established: sessions that ran before this feature, sessions the plugin first
  saw after they had started (the first request already carried earlier turns, e.g. a fork), or a subagent without
  data. Nothing is reconstructed for them.

The start is captured from OpenCode's `prompt` hook (before the agent loop) and confirmed by the first `context`
hook: that request must contain no earlier assistant or tool turn. Changes are noticed on later model requests; a
non-read tool aimed at a context path also makes the next request re-list the files. The check stats the files and
re-hashes only those whose mtime or size changed, so it is cheap, and no tool call scans the file system. As with
coverage, an edit that keeps both mtime and size is invisible. Zero-read sessions and subagents get a revision record
like any other.

### Workflow and commands

1. Run `/context-analyze` or `/context-review`, then press **`e`** in the panel (`n`, `f`, `r`, `esc` are unchanged).
   Name the experiment, state the hypothesis, choose the target context files (the ones the session did not fully
   read are preselected) and optionally a task category. This records the current revision as the **baseline**.
2. Edit the documentation yourself.
3. `/context-experiments` → the experiment → **Check for the documentation change**. The plugin compares the target
   files with the baseline and shows what changed; if you confirm, that revision becomes the **candidate**. A later
   revision is never linked automatically, and one that leaves the target files unchanged cannot be confirmed. Other
   context files that also changed are listed: they confound the comparison.
4. Let sessions run. In `/context-experiments` choose **Select baseline sessions** and **Select candidate sessions**.
   Sessions whose whole context matches the anchor revision are listed first; any session can be picked, and ones that
   do not fit are shown as excluded in the evaluation. A subagent is grouped under its lead: one lead and its subagents
   are one sample, not several.
5. Optionally **Label a session's outcome**: your own judgment of task success and instruction adherence, with a note
   or an evidence reference.
6. `/context-evaluate` → the experiment. Close an experiment from the same menu; its record stays.

### What is measured

Only deterministic evidence, from the read records, revision records and OpenCode's own message log (derived in the
TUI, as for `/context-analyze`). Samples are lead sessions; zero-read sessions stay in the denominator.

| group | metric | note |
| --- | --- | --- |
| discovery | sessions that read a target file | explicit tool reads only; auto-loaded files are invisible to the hooks, so no read is not proof the agent lacked the content. When every target is auto-loaded the metric is missing, not zero |
| discovery | target read before the first file change | needs the message log; missing when it is unavailable or the session changed nothing |
| discovery | target files read completely | judged against the file as it was read |
| efficiency | repeat reads, cross-agent rereads, failed reads, delivered/requested lines, total context reads | signals only: a repeat is not called wasteful, and none gets a verdict |
| verification | sessions with a test/check/build-like command, exit code known, non-zero exits | command names are matched locally and never stored; says nothing about whether the work was correct |
| outcome (labeled) | task success, instruction adherence | only from your labels, and only labels with a note or evidence reference; unlabeled stays unknown |

Each metric shows baseline and candidate sample sizes, values, the absolute change (**percentage points** for rates,
units for means), the relative change where the baseline is not zero, and how many sessions had no evidence. The
verdict per metric is `improved`, `regressed`, `unchanged` or `inconclusive`:

* A verdict needs at least 3 sessions per side. A rate change of 20 percentage points or more counts; under 10 is
  `unchanged`; in between is `inconclusive`. This is descriptive, not a significance test.
* It is `inconclusive` when samples are too few, evidence is missing, or the sides cannot be shown to be comparable
  (below). The measurements are still shown; only the directional claim is withdrawn.

### What the verdicts mean

The result has two verdicts, never blended into one score:

* **Discovery** (`improved`, `regressed`, `unchanged`, `inconclusive`): did agents read the target files more, earlier
  or more completely? `improved` means exactly that. It does not show that agents did better work.
* **Task effectiveness**: decided only by your grounded outcome labels (task success, instruction adherence). With too
  few labels it reads *unknown (inconclusive)*, even when discovery improved. Effectiveness `improved` still does not
  control for task difficulty.

Efficiency and verification metrics are signals and never get a verdict.

Both verdicts are `inconclusive` unless the two sides are confirmed comparable. *Unknown* blocks as much as *different*:

* **Model or plugin configuration.** If any session on either side has no recorded model or configuration, comparability
  is unknown. A change nobody recorded looks the same as no change, so no directional claim is made. Confirmed
  differences are reported as "not comparable", missing metadata as "comparability unknown".
* **Revision snapshots.** The baseline and candidate snapshots are how the plugin knows no other context file changed.
  If either is missing or damaged, that cannot be established, so the evaluation is `inconclusive` with an explanation.
* **Other context files.** A change outside the target files between the two revisions confounds the comparison.
* **Sessions.** Sessions with a mixed, unknown or mismatched revision, or with unreadable read records, are excluded
  with the reason; they are never counted as zero reads.

Model and plugin-configuration metadata are recorded with each evaluation (never secrets) and differences are listed.
Each evaluation is stored with the experiment together with its per-session measurements, so it can be recomputed.
Evaluations stored before the two verdicts were separated show their single verdict with a note.

### Known limitations and recommended process

Sessions are chosen by hand and task difficulty is not measured; there is no significance test; only explicit tool
reads are observed. To get a fair comparison, run the same kind of task (a similar bug fix, say) on both sides, with the
same model and plugin options, at least 3 sessions per side, change only the target files between the revisions,
leave the experiment's other context files alone, and label outcomes with a note or a PR/CI reference.

### Data

Evaluation metadata lives in `<dataDir>/evaluation/`, apart from the read logs, which are unchanged:

```
evaluation/snapshots/<revisionId>.json   file paths, hashes, sizes of one revision (written once)
evaluation/sessions/<sessionID>.json     the revision(s) a session ran under, models, agents
evaluation/experiments/<id>.json         experiment, selected sessions, labels, stored evaluations
```

Files carry `version: 1` and are written atomically (temporary file, then rename). A damaged or unknown-version file
reads as absent and is left in place. Hashes are computed locally; nothing is sent to a model or a service.
The evaluation RPC methods (`listExperiments`, `createExperiment`, `evaluateExperiment`, …) are additive: update the
server and TUI together.

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
(`sessions/`, `tracking.json`, `evaluation/`). Downgrading is safe: older versions ignore the new fields and files. The RPC gained
fields (`tracking`, `certainty`, `agents`, …), so update the server and TUI halves together.

## E2E test

`e2e/run.sh /path/to/opencode2` runs six real `opencode run` sessions concurrently (plus the two subagent ones they
spawn) against a copy of `e2e/project` with the plugin loaded, then asserts what was recorded (`e2e/assert.mjs`, then
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
| F → N | F delegates to a subagent that reads only a non-context file | a subagent with zero context reads is still an observed child of its spawner |
| G | writes `.ai/style.md` itself, then reads `AGENTS.md` (run alone, after A-F) | a context change during a session makes it `mixed` |
| H, I, J → K | after G: H reads `.ai/style.md`, I reads nothing, J delegates the read to K (run together) | sessions on the new revision share one id; a lead and its subagent are one sample |

The first six sessions are asserted before G, H, I and J run (they add sessions). Then `test/e2e-evaluation.test.ts`
restores the pre-change `style.md`, creates an experiment on the real data (its baseline id must equal the one the
live sessions recorded), confirms the change as the candidate, selects the sessions (including mixed G by mistake) and
checks the exclusion, the grouping, the metrics and the verdict.

Limitations: the E2E does not drive the terminal UI, so the child-session discovery used by `/context-analyze`
(`session.list({ parentID })`) is covered by unit tests with a fake listing, not live. OpenCode's stock subagents cannot spawn further agents, so nested delegation is covered by unit tests
only. The terminal UI is covered by unit tests of its formatting and data logic, not by the E2E.

CI (`.github/workflows/ci.yml`) runs `npm ci`, typecheck and unit tests, then this E2E on Linux against the pinned
`@opencode/cli@2.0.32`. The E2E job fails (it is never skipped) if that binary cannot be installed or does not report
the pinned version, and its summary states what the E2E does not cover.
