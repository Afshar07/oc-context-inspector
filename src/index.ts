import { Plugin } from "@opencode/plugin";
import * as path from "node:path";
import { ContextPathMatcher, DEFAULT_CONTEXT_PATHS } from "./matcher.js";
import { JsonlContextReadStore } from "./store.js";
import { ContextReadTracker } from "./tracker.js";
import type { IContextInspectorOptions } from "./types.js";

export { ContextPathMatcher, ContextReadTracker, JsonlContextReadStore };
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
  };
}

export default Plugin.define({
  id: "opencode-context-inspector",
  async setup(ctx) {
    const options = resolveOptions(ctx.options, ctx.location.directory);
    const tracker = new ContextReadTracker(
      new ContextPathMatcher(ctx.location.directory, options.contextPaths),
      new Set(options.tools),
      new JsonlContextReadStore(options.dataDir),
    );

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
