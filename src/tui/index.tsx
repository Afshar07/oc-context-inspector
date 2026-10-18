/** @jsxImportSource @opentui/solid */
import { Plugin } from "@opencode/plugin/tui";
import { createSignal, Match, Show, Switch } from "solid-js";
import type { IFileCoverage } from "../types.js";
import { Analysis, type EAnalysisMode } from "./Analysis.js";
import { Evaluation } from "./Evaluation.js";
import { rpcExperimentClient } from "./experiment-client.js";
import { experimentFlows } from "./experiment-flow.js";
import { DEFAULT_MODEL, pickAnalysisModel, rpcCoverageClient, startFollowUpSession, userPrompts } from "./client.js";
import { describeFile, STATUS_GLYPH, visibleFiles } from "./format.js";
import { handoffMessage } from "./handoff.js";
import { Preview } from "./Preview.js";
import { Sidebar } from "./Sidebar.js";
import type { ICoverageClient } from "./source.js";

const PANEL_NAME = "context-inspector.preview";
const EVALUATION_PANEL = "context-inspector.evaluate";
const ANALYSIS_PANELS: Readonly<Record<EAnalysisMode, string>> = {
  session: "context-inspector.analysis.session",
  project: "context-inspector.analysis.project",
};
/** Keymap mode while the sidebar list is browsed with the keyboard; other layers are inactive. */
const BROWSE_MODE = "context-inspector.browse";

export default Plugin.define({
  id: "opencode-context-inspector",
  setup(ctx) {
    const client = rpcCoverageClient(ctx);
    const experimentClient = rpcExperimentClient(ctx);
    const [selected, setSelected] = createSignal<string>();
    const [evaluating, setEvaluating] = createSignal<string>();
    // Durable, so the choice survives TUI restarts.
    const [prefs, setPrefs] = ctx.storage.store("prefs", { initial: { showUnread: false, collapsed: false, analysisModel: DEFAULT_MODEL } });
    // Model picked for the analysis panel currently open; read by its resource, so a new pick reruns it.
    const [analysisModel, setAnalysisModel] = createSignal<string>();
    const browse = createBrowseState(ctx, client, () => prefs.showUnread);

    const setCollapsed = (collapsed: boolean) =>
      setPrefs((draft) => {
        draft.collapsed = collapsed;
      });
    const toggleCollapsed = () => {
      browse.stop();
      return setCollapsed(prefs.collapsed !== true);
    };

    const openPreview = (filePath: string) => {
      setSelected(filePath);
      if (!ctx.ui.panel.open(PANEL_NAME)) ctx.ui.toast.show({ variant: "warning", message: "Open a session first" });
    };
    const openAnalysis = async (mode: EAnalysisMode, sessionID: string) => {
      const picked = await pickAnalysisModel(ctx, sessionID, prefs.analysisModel ?? DEFAULT_MODEL);
      if (picked === undefined) return;
      await setPrefs((draft) => {
        draft.analysisModel = picked;
      });
      setAnalysisModel(picked === DEFAULT_MODEL ? undefined : picked);
      if (!ctx.ui.panel.open(ANALYSIS_PANELS[mode])) ctx.ui.toast.show({ variant: "warning", message: "Open a session first" });
    };
    // Follow-up session for acting on a review: the review waits, queued, for the user's first instruction.
    const continueInSession = (mode: EAnalysisMode, sessionID: string) => async (answer: { text: string; model: string; sessionCount?: number }, fork: boolean) => {
      try {
        const files = mode === "session" ? ((await client.coverage(sessionID).catch(() => undefined))?.files ?? []) : [];
        const title = ctx.data.session.get(sessionID)?.title;
        const id = await startFollowUpSession(ctx, {
          fork,
          sessionID,
          model: answer.model,
          title: mode === "session" ? `Context fixes: ${title ?? "session"}` : "Context fixes: project review",
          message: handoffMessage({
            mode,
            answer: answer.text,
            model: answer.model,
            sessionCount: answer.sessionCount,
            files,
            forked: fork,
            ...(mode === "session" && !fork && { task: await userPrompts(ctx, sessionID) }),
          }),
        });
        ctx.ui.panel.close();
        if (!ctx.ui.tabs.focus(id)) ctx.ui.router.navigate({ type: "session", sessionID: id });
        ctx.ui.toast.show({ variant: "info", message: "Review queued. Tell the agent what to change." });
      } catch (error) {
        ctx.ui.toast.show({ variant: "error", message: `Could not open a session: ${(error as Error).message}` });
      }
    };
    const currentSession = () => {
      const route = ctx.ui.router.current();
      return route.type === "session" ? route.sessionID : undefined;
    };
    const openEvaluation = (id: string) => {
      setEvaluating(id);
      if (!ctx.ui.panel.open(EVALUATION_PANEL)) ctx.ui.toast.show({ variant: "warning", message: "Open a session first" });
    };
    const flows = experimentFlows(ctx, experimentClient, {
      openEvaluation,
      coverageFiles: async (sessionID) => (await client.coverage(sessionID).catch(() => undefined))?.files,
    });
    // The analysis panel's `e`: the experiment is about the project's context files, seen from the reviewed session.
    const startExperiment = (mode: EAnalysisMode, sessionID: string) => async () => {
      const report = await client.coverage(sessionID).catch(() => undefined);
      if (!report) {
        ctx.ui.toast.show({ variant: "error", message: "Could not read the context files" });
        return;
      }
      // The review stays open behind the dialogs: its text is what the hypothesis is written from.
      await flows.createFromAnalysis(
        sessionID,
        mode === "session" ? { kind: "session-analysis", sessionID } : { kind: "project-review", sessionID },
        report.files,
      );
    };

    const disposers = [
      ctx.ui.slot({
        append: "sidebar.content",
        render: (input) => (
          <Sidebar
            ctx={ctx}
            client={client}
            sessionID={input.sessionID}
            showUnread={prefs.showUnread}
            cursor={browse.sessionID() === input.sessionID ? browse.cursor() : undefined}
            collapsed={prefs.collapsed === true}
            onToggle={toggleCollapsed}
            onOpen={openPreview}
          />
        ),
      }),
      ctx.ui.slot({
        append: "session.panel",
        render: (input) => (
          <Switch>
            <Match when={input.name === PANEL_NAME && selected()}>
              {(filePath) => <Preview ctx={ctx} client={client} panel={input} filePath={filePath()} />}
            </Match>
            <Match when={input.name === ANALYSIS_PANELS.session}>
              <Analysis
                ctx={ctx}
                client={client}
                panel={input}
                mode="session"
                model={analysisModel()}
                onContinue={continueInSession("session", input.sessionID)}
                onExperiment={() => void startExperiment("session", input.sessionID)()}
              />
            </Match>
            <Match when={input.name === ANALYSIS_PANELS.project}>
              <Analysis
                ctx={ctx}
                client={client}
                panel={input}
                mode="project"
                model={analysisModel()}
                onContinue={continueInSession("project", input.sessionID)}
                onExperiment={() => void startExperiment("project", input.sessionID)()}
              />
            </Match>
            <Match when={input.name === EVALUATION_PANEL && evaluating()}>
              {(id) => <Evaluation ctx={ctx} client={experimentClient} panel={input} experimentId={id()} />}
            </Match>
          </Switch>
        ),
      }),
      // Layers live inside a mounted component, like OpenCode's own plugins register theirs.
      ctx.ui.slot({
        append: "app",
        render: () => {
          // "global", like OpenCode's own /btw and /diff: base-mode commands are reachable but
          // never offered by the prompt's slash completion.
          ctx.keymap.layer(() => ({
            mode: "global",
            commands: [
              {
                id: "context-inspector.files",
                title: "Context files",
                description: "Pick a project context file and preview what the agent read of it",
                group: "Session",
                palette: true,
                slash: { name: "context" },
                enabled: () => currentSession() !== undefined,
                run: async () => {
                  const sessionID = currentSession();
                  if (!sessionID) return;
                  const filePath = await pickFile(ctx, client, sessionID);
                  if (filePath) openPreview(filePath);
                },
              },
              {
                id: "context-inspector.analyze",
                title: "Analyze this session's context reads",
                description: "Ask a model whether the agent read the context this task needed",
                group: "Session",
                palette: true,
                slash: { name: "context-analyze" },
                enabled: () => currentSession() !== undefined,
                run: () => {
                  const sessionID = currentSession();
                  if (sessionID) void openAnalysis("session", sessionID);
                },
              },
              {
                id: "context-inspector.review",
                title: "Review context files across sessions",
                description: "Ask a model how agents use the project's context files, and what to change",
                group: "Session",
                palette: true,
                slash: { name: "context-review" },
                enabled: () => currentSession() !== undefined,
                run: () => {
                  const sessionID = currentSession();
                  if (sessionID) void openAnalysis("project", sessionID);
                },
              },
              {
                id: "context-inspector.experiments",
                title: "Context experiments",
                description: "List, inspect and manage experiments that test a documentation change",
                group: "Session",
                palette: true,
                slash: { name: "context-experiments" },
                enabled: () => currentSession() !== undefined,
                run: () => {
                  const sessionID = currentSession();
                  if (sessionID) void flows.manage(sessionID);
                },
              },
              {
                id: "context-inspector.evaluate",
                title: "Evaluate a context experiment",
                description: "Compare sessions before and after a documentation change",
                group: "Session",
                palette: true,
                slash: { name: "context-evaluate" },
                enabled: () => currentSession() !== undefined,
                run: async () => {
                  const sessionID = currentSession();
                  if (!sessionID) return;
                  const id = await flows.chooseForEvaluation(sessionID);
                  if (id) openEvaluation(id);
                },
              },
              {
                id: "context-inspector.toggle-unread",
                title: "Show/hide unread context files",
                group: "Session",
                palette: true,
                slash: { name: "context-unread" },
                run: async () => {
                  browse.stop();
                  await setPrefs((draft) => {
                    draft.showUnread = !draft.showUnread;
                  });
                },
              },
              {
                id: "context-inspector.collapse",
                title: "Collapse/expand context files in sidebar",
                group: "Session",
                palette: true,
                slash: { name: "context-collapse" },
                run: () => toggleCollapsed(),
              },
              {
                id: "context-inspector.browse",
                title: "Browse context files in sidebar",
                group: "Session",
                palette: true,
                slash: { name: "context-browse" },
                enabled: () => currentSession() !== undefined,
                run: () => {
                  const sessionID = currentSession();
                  if (!sessionID) return;
                  // Browsing needs the list on screen.
                  if (prefs.collapsed === true) void setCollapsed(false);
                  void browse.start(sessionID);
                },
              },
            ],
          }));
          ctx.keymap.layer(() => ({
            mode: BROWSE_MODE,
            enabled: browse.sessionID() !== undefined,
            commands: [
              { title: "Previous file", bind: "up,k", run: () => browse.move(-1) },
              { title: "Next file", bind: "down,j", run: () => browse.move(1) },
              {
                title: "Preview file",
                bind: "return",
                run: () => {
                  const file = browse.current();
                  browse.stop();
                  if (file) openPreview(file.filePath);
                },
              },
              { title: "Stop browsing", bind: "escape", run: () => browse.stop() },
            ],
          }));
          return null;
        },
      }),
    ];

    return () => {
      browse.stop();
      for (const dispose of disposers) dispose();
    };
  },
});

/** Keyboard browsing of the sidebar list: owns the keymap mode and the cursor. */
function createBrowseState(ctx: Plugin.Context, client: ICoverageClient, showUnread: () => boolean) {
  const [sessionID, setSessionID] = createSignal<string>();
  const [files, setFiles] = createSignal<readonly IFileCoverage[]>([]);
  const [cursor, setCursor] = createSignal(0);
  let popMode: (() => void) | undefined;

  const stop = () => {
    popMode?.();
    popMode = undefined;
    setSessionID(undefined);
  };
  return {
    sessionID,
    cursor,
    current: () => files()[cursor()],
    move: (delta: number) => setCursor((c) => Math.min(Math.max(c + delta, 0), Math.max(files().length - 1, 0))),
    stop,
    async start(id: string) {
      // Same server-sorted list and filter as the sidebar, so cursor indexes line up.
      const report = await client.coverage(id).catch(() => undefined);
      const visible = report ? visibleFiles(report.files, showUnread()) : [];
      if (visible.length === 0) {
        ctx.ui.toast.show({ variant: "info", message: "No context files to browse; /context-unread shows unread ones" });
        return;
      }
      stop();
      setFiles(visible);
      setCursor(0);
      setSessionID(id);
      popMode = ctx.keymap.mode.push(BROWSE_MODE);
    },
  };
}

async function pickFile(ctx: Plugin.Context, client: ICoverageClient, sessionID: string) {
  let files: readonly IFileCoverage[];
  try {
    files = (await client.coverage(sessionID)).files;
  } catch (error) {
    ctx.ui.toast.show({ variant: "error", message: `Context inspector: ${(error as Error).message}` });
    return undefined;
  }
  return ctx.ui.dialog.select({
    title: "Context files",
    placeholder: "Filter files",
    options: files.map((file) => ({
      title: `${STATUS_GLYPH[file.status]} ${file.filePath}`,
      value: file.filePath,
      description: describeFile(file) || file.status,
    })),
  });
}
