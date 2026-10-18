import { Plugin } from "@opencode/plugin";
import { createHash } from "node:crypto";
import * as path from "node:path";
import { AnalysisService } from "./analysis.js";
import { CoverageService } from "./coverage.js";
import { EvaluationService } from "./evaluation/evaluate.js";
import { ExperimentService } from "./evaluation/experiments.js";
import { GroupResolver } from "./evaluation/groups.js";
import { evaluationHandlers, type IEvaluationServices } from "./evaluation/rpc-handlers.js";
import { RevisionSnapshotter } from "./evaluation/revisions.js";
import { SessionRevisionTracker } from "./evaluation/session-revisions.js";
import { EvaluationStore } from "./evaluation/store.js";
import { ContextPathMatcher, DEFAULT_CONTEXT_PATHS } from "./matcher.js";
import { formatModelRef, parseModelRef } from "./model-ref.js";
import { ContextInspectorRpc } from "./rpc.js";
import { SessionObserver, SessionRegistry, startTracking } from "./sessions.js";
import { JsonlContextReadStore } from "./store.js";
import { ContextReadTracker } from "./tracker.js";
import type { IContextInspectorOptions, IContextReadStore, IModelRef } from "./types.js";

export { ContextPathMatcher, ContextReadTracker, CoverageService, JsonlContextReadStore };
export { ContextInspectorRpc } from "./rpc.js";
export { readSessionRecords } from "./store.js";
export { SessionObserver, SessionRegistry } from "./sessions.js";
export { parseModelRef } from "./model-ref.js";
export * from "./evaluation/types.js";
export * from "./types.js";

function stringList(value: unknown, fallback: readonly string[]): readonly string[] {
  return Array.isArray(value) && value.every((v) => typeof v === "string") && value.length > 0
    ? value
    : fallback;
}

export function resolveOptions(
  raw: Readonly<Record<string, unknown>>,
  directory: string,
): IContextInspectorOptions {
  const dataDir = typeof raw.dataDir === "string" ? raw.dataDir : ".opencode/context-inspector";
  return {
    contextPaths: stringList(raw.contextPaths, DEFAULT_CONTEXT_PATHS),
    tools: stringList(raw.tools, ["read"]),
    dataDir: path.resolve(directory, dataDir),
    autoLoaded: stringList(raw.autoLoaded, ["AGENTS.md"]),
    analysis: (() => {
      const a = (typeof raw.analysis === "object" && raw.analysis !== null ? raw.analysis : {}) as Record<string, unknown>;
      const model = parseModelRef(a.model);
      return { ...(model && { model }), includeContent: a.includeContent === true };
    })(),
  };
}

const failure = (error: unknown) => ({ ok: false as const, error: error instanceof Error ? error.message : String(error) });


/** Identifies the plugin options that shape what is tracked, so sessions run under different settings are not pooled. */
function environmentSignature(options: IContextInspectorOptions): string {
  const parts = [[...options.contextPaths].sort(), [...options.tools].sort(), [...options.autoLoaded].sort()];
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex").slice(0, 12);
}

function registerRpc(
  ctx: Plugin.Context,
  coverage: CoverageService,
  analysis: AnalysisService,
  evaluation: IEvaluationServices,
  configured?: IModelRef,
) {
  // Resolved per call and passed explicitly, so the label shown is the model that actually ran.
  const resolveModel = async (): Promise<IModelRef | undefined> => {
    if (configured) return configured;
    const fallback = await ctx.model.default().catch(() => undefined);
    return fallback?.data ? { providerID: fallback.data.providerID, id: fallback.data.id } : undefined;
  };
  /** `requested` (the user's pick in the TUI) wins over the configured and default models. */
  const withModel = async <T extends object>(
    requested: string | undefined,
    run: (model: IModelRef | undefined) => Promise<T>,
  ) => {
    const picked = requested === undefined ? undefined : parseModelRef(requested);
    if (requested !== undefined && !picked) throw new Error(`Unknown model id: ${requested}`);
    const model = picked ?? (await resolveModel());
    return { ok: true as const, ...(await run(model)), model: model ? formatModelRef(model) : "OpenCode default" };
  };

  return ctx.rpc.register(ContextInspectorRpc, {
    coverage: ({ sessionID }) => coverage.coverage(sessionID),
    preview: async ({ sessionID, filePath }) => {
      const preview = await coverage.preview(sessionID, filePath);
      return preview ? { found: true as const, preview } : { found: false as const };
    },
    // Model failures (no provider, rate limits) are answers for the TUI to show, not RPC faults.
    analyzeSession: ({ sessionID, task, model, timeline }) =>
      withModel(model, async (m) => ({
        text: await analysis.analyzeSession(sessionID, task, m, timeline && {
          events: timeline.events,
          omitted: timeline.omitted,
          ...(timeline.sessions !== undefined && { sessions: timeline.sessions }),
        }),
      })).catch(failure),
    reviewProject: ({ model }) => withModel(model, (m) => analysis.reviewProject(m)).catch(failure),
    ...evaluationHandlers(evaluation),
  });
}

export default Plugin.define({
  id: "opencode-context-inspector",
  async setup(ctx) {
    const options = resolveOptions(ctx.options, ctx.location.directory);
    const matcher = new ContextPathMatcher(ctx.location.directory, options.contextPaths);
    const registry = new SessionRegistry(options.dataDir);
    const coverage = new CoverageService(ctx.location.directory, matcher, options, registry);
    const { includeContent } = options.analysis;
    const analysis = new AnalysisService(
      coverage,
      options.dataDir,
      async (prompt, model) => (await ctx.generate.text({ prompt, ...(model && { model }) })).text,
      { includeContent },
      registry,
    );

    // Evaluation metadata lives apart from the read logs, under `<dataDir>/evaluation/`.
    const evaluationStore = new EvaluationStore(options.dataDir);
    const snapshotter = new RevisionSnapshotter(ctx.location.directory, () => coverage.listContextFiles());
    const groups = new GroupResolver(registry, evaluationStore);
    const experiments = new ExperimentService({ store: evaluationStore, snapshotter, matcher, groups });
    const evaluation = new EvaluationService({
      experiments,
      groups,
      store: evaluationStore,
      dataDir: options.dataDir,
      autoLoaded: options.autoLoaded,
    });
    const revisions = new SessionRevisionTracker(evaluationStore, snapshotter, environmentSignature(options));

    // Serves the TUI sidebar. Recording must keep working if RPC is unavailable.
    let rpc: Awaited<ReturnType<typeof registerRpc>> | undefined;
    try {
      rpc = await registerRpc(ctx, coverage, analysis, { experiments, evaluation, groups, snapshotter }, options.analysis.model);
    } catch {}

    const jsonl = new JsonlContextReadStore(options.dataDir);
    const store: IContextReadStore = {
      async append(record) {
        await jsonl.append(record);
        // A live-update hint only; the TUI refetches, so a lost event just delays it.
        // `ancestors` lets the sidebar of a lead session refresh when a subagent reads.
        const ancestors = await registry.ancestors(record.sessionID).catch(() => []);
        rpc?.events.emit("read", { sessionID: record.sessionID, filePath: record.filePath, ancestors }).catch(() => {});
      },
    };
    // Which sessions exist, and who spawned them, comes from OpenCode; a failed lookup leaves the lineage unknown.
    const observer = new SessionObserver(options.dataDir, async (sessionID) => {
      const session = await ctx.session.get({ sessionID });
      return session ? { ...(session.parentID !== undefined && { parentID: session.parentID }) } : undefined;
    });
    const tracker = new ContextReadTracker(matcher, new Set(options.tools), store, undefined, { sessions: observer });
    startTracking(options.dataDir).catch(() => {});

    // The prompt arrives before the agent loop: an early snapshot of the context for a new session.
    // Observation only; a failure here must never hold up or alter the prompt.
    try {
      await ctx.session.hook("prompt", async (event) => {
        try {
          await revisions.observe({ sessionID: event.sessionID, source: "prompt" });
        } catch {}
      });
    } catch {}

    // A session that only talks (no tool call) still ran, so a zero-read session is a fact, not a gap.
    // The hook may fire for every model request, so revision capture is idempotent and cheap after the first.
    try {
      await ctx.session.hook("context", async (event) => {
        observer.observe(event.sessionID).catch(() => {});
        try {
          const { model, agent, messages } = event;
          await revisions.observe({
            sessionID: event.sessionID,
            source: "context",
            // A first request with no assistant or tool turn is the start of the session; anything else began earlier.
            // Without a message list the history is unknown, which is treated as "has history".
            priorTurns: messages?.some((m) => m.role === "assistant" || m.role === "tool") ?? true,
            ...(model && { model: formatModelRef({ providerID: model.providerID, id: model.id, ...(model.variant !== undefined && { variant: model.variant }) }) }),
            ...(agent !== undefined && { agent }),
          });
        } catch {}
      });
    } catch {}

    // Observer only: a failure here must never reach the agent, so errors are swallowed.
    await ctx.tool.hook("execute.before", (event) => {
      try {
        tracker.onBefore(event);
        // A non-read tool aimed at a context file may change it: re-list the files at the next model request.
        // Only a path match, so a tool call never scans the file system.
        if (!options.tools.includes(event.tool)) {
          const args = event.input as { path?: unknown; filePath?: unknown } | null | undefined;
          const target = typeof args?.path === "string" ? args.path : typeof args?.filePath === "string" ? args.filePath : undefined;
          if (target !== undefined && matcher.match(target)) snapshotter.invalidate();
        }
      } catch {}
    });
    await ctx.tool.hook("execute.after", async (event) => {
      try {
        await tracker.onAfter(event);
      } catch {}
    });
  },
});
