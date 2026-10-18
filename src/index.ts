import { Plugin } from "@opencode/plugin";
import * as path from "node:path";
import { AnalysisService } from "./analysis.js";
import { CoverageService } from "./coverage.js";
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


function registerRpc(ctx: Plugin.Context, coverage: CoverageService, analysis: AnalysisService, configured?: IModelRef) {
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

    // Serves the TUI sidebar. Recording must keep working if RPC is unavailable.
    let rpc: Awaited<ReturnType<typeof registerRpc>> | undefined;
    try {
      rpc = await registerRpc(ctx, coverage, analysis, options.analysis.model);
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

    // A session that only talks (no tool call) still ran, so a zero-read session is a fact, not a gap.
    try {
      await ctx.session.hook("context", (event) => {
        observer.observe(event.sessionID).catch(() => {});
      });
    } catch {}

    // Observer only: a failure here must never reach the agent, so errors are swallowed.
    await ctx.tool.hook("execute.before", (event) => {
      try {
        tracker.onBefore(event);
      } catch {}
    });
    await ctx.tool.hook("execute.after", async (event) => {
      try {
        await tracker.onAfter(event);
      } catch {}
    });
  },
});
