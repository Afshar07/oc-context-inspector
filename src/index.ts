import { Plugin } from "@opencode/plugin";
import * as path from "node:path";
import { AnalysisService } from "./analysis.js";
import { CoverageService } from "./coverage.js";
import { ContextPathMatcher, DEFAULT_CONTEXT_PATHS } from "./matcher.js";
import { ContextInspectorRpc } from "./rpc.js";
import { JsonlContextReadStore } from "./store.js";
import { ContextReadTracker } from "./tracker.js";
import type { IContextInspectorOptions, IContextReadStore, IModelRef } from "./types.js";

export { ContextPathMatcher, ContextReadTracker, CoverageService, JsonlContextReadStore };
export { ContextInspectorRpc } from "./rpc.js";
export { readSessionRecords } from "./store.js";
export * from "./types.js";

function stringList(value: unknown, fallback: readonly string[]): readonly string[] {
  return Array.isArray(value) && value.every((v) => typeof v === "string") && value.length > 0
    ? value
    : fallback;
}

/** `provider/model` or `provider/model#variant`, as OpenCode writes model IDs. */
export function parseModelRef(value: unknown): IModelRef | undefined {
  if (typeof value !== "string") return undefined;
  const match = /^([^/#]+)\/([^#]+)(?:#(.+))?$/.exec(value);
  if (!match) return undefined;
  return { providerID: match[1]!, id: match[2]!, ...(match[3] !== undefined && { variant: match[3] }) };
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

const modelLabel = (m: IModelRef) => `${m.providerID}/${m.id}${m.variant ? `#${m.variant}` : ""}`;

function registerRpc(ctx: Plugin.Context, coverage: CoverageService, analysis: AnalysisService, configured?: IModelRef) {
  // Resolved per call and passed explicitly, so the label shown is the model that actually ran.
  const resolveModel = async (): Promise<IModelRef | undefined> => {
    if (configured) return configured;
    const fallback = await ctx.model.default().catch(() => undefined);
    return fallback?.data ? { providerID: fallback.data.providerID, id: fallback.data.id } : undefined;
  };
  const withModel = async <T extends object>(run: (model: IModelRef | undefined) => Promise<T>) => {
    const model = await resolveModel();
    return { ok: true as const, ...(await run(model)), model: model ? modelLabel(model) : "OpenCode default" };
  };

  return ctx.rpc.register(ContextInspectorRpc, {
    coverage: ({ sessionID }) => coverage.coverage(sessionID),
    preview: async ({ sessionID, filePath }) => {
      const preview = await coverage.preview(sessionID, filePath);
      return preview ? { found: true as const, preview } : { found: false as const };
    },
    // Model failures (no provider, rate limits) are answers for the TUI to show, not RPC faults.
    analyzeSession: ({ sessionID, task }) =>
      withModel(async (model) => ({ text: await analysis.analyzeSession(sessionID, task, model) })).catch(failure),
    reviewProject: () => withModel((model) => analysis.reviewProject(model)).catch(failure),
  });
}

export default Plugin.define({
  id: "opencode-context-inspector",
  async setup(ctx) {
    const options = resolveOptions(ctx.options, ctx.location.directory);
    const matcher = new ContextPathMatcher(ctx.location.directory, options.contextPaths);
    const coverage = new CoverageService(ctx.location.directory, matcher, options);
    const { includeContent } = options.analysis;
    const analysis = new AnalysisService(
      coverage,
      options.dataDir,
      async (prompt, model) => (await ctx.generate.text({ prompt, ...(model && { model }) })).text,
      { includeContent },
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
        rpc?.events.emit("read", { sessionID: record.sessionID, filePath: record.filePath }).catch(() => {});
      },
    };
    const tracker = new ContextReadTracker(matcher, new Set(options.tools), store);

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
