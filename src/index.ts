import { Plugin } from "@opencode/plugin";
import * as path from "node:path";
import { CoverageService } from "./coverage.js";
import { ContextPathMatcher, DEFAULT_CONTEXT_PATHS } from "./matcher.js";
import { ContextInspectorRpc } from "./rpc.js";
import { JsonlContextReadStore } from "./store.js";
import { ContextReadTracker } from "./tracker.js";
import type { IContextInspectorOptions, IContextReadStore } from "./types.js";

export { ContextPathMatcher, ContextReadTracker, CoverageService, JsonlContextReadStore };
export { ContextInspectorRpc } from "./rpc.js";
export { readSessionRecords } from "./store.js";
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
  };
}

function registerRpc(ctx: Plugin.Context, coverage: CoverageService) {
  return ctx.rpc.register(ContextInspectorRpc, {
    coverage: ({ sessionID }) => coverage.coverage(sessionID),
    preview: async ({ sessionID, filePath }) => {
      const preview = await coverage.preview(sessionID, filePath);
      return preview ? { found: true as const, preview } : { found: false as const };
    },
  });
}

export default Plugin.define({
  id: "opencode-context-inspector",
  async setup(ctx) {
    const options = resolveOptions(ctx.options, ctx.location.directory);
    const matcher = new ContextPathMatcher(ctx.location.directory, options.contextPaths);
    const coverage = new CoverageService(ctx.location.directory, matcher, options);

    // Serves the TUI sidebar. Recording must keep working if RPC is unavailable.
    let rpc: Awaited<ReturnType<typeof registerRpc>> | undefined;
    try {
      rpc = await registerRpc(ctx, coverage);
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
