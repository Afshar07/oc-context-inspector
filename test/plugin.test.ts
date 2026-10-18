import { mkdir, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import plugin, { parseModelRef, readSessionRecords, resolveOptions } from "../src/index.js";
import { ECoverageStatus, type ICoverageReport } from "../src/types.js";
import { withTempDir } from "./helpers.js";

type Hook = (event: Record<string, unknown>) => unknown;

/** Minimal stand-in for the V2 plugin context: just enough to capture tool hooks. */
function fakeContext(
  directory: string,
  options: Record<string, unknown> = {},
  withRpc = false,
  generate: (input: { prompt: string; model?: unknown }) => Promise<{ text: string }> = async () => ({ text: "" }),
) {
  const hooks: Record<string, Hook> = {};
  const rpc = {
    id: undefined as string | undefined,
    handlers: {} as Record<string, (input: Record<string, unknown>) => Promise<unknown>>,
    emitted: [] as unknown[][],
  };
  const ctx = {
    options,
    location: { directory },
    generate: { text: generate },
    tool: {
      hook: async (name: string, cb: Hook) => {
        hooks[name] = cb;
        return { dispose: async () => {} };
      },
    },
    ...(withRpc && {
      rpc: {
        register: async (definition: { id: string }, handlers: typeof rpc.handlers) => {
          rpc.id = definition.id;
          rpc.handlers = handlers;
          return { dispose: async () => {}, events: { emit: async (...args: unknown[]) => void rpc.emitted.push(args) } };
        },
      },
    }),
  };
  return { ctx: ctx as never, hooks, rpc };
}

describe("plugin wiring", () => {
  it("has a stable id and registers both tool hooks", async () => {
    await withTempDir(async (dir) => {
      const { ctx, hooks } = fakeContext(dir);
      await plugin.setup(ctx);
      expect(plugin.id).toBe("opencode-context-inspector");
      expect(Object.keys(hooks).sort()).toEqual(["execute.after", "execute.before"]);
    });
  });

  it("persists records end to end and never mutates events", () =>
    withTempDir(async (dir) => {
      const { ctx, hooks } = fakeContext(dir, { dataDir: "out" });
      await plugin.setup(ctx);
      const input = { path: ".ai/x.md", offset: 3, limit: 4 };
      const result = { output: "FILE CONTENTS", metadata: {} };
      const before = { tool: "read", sessionID: "s1", id: "c1", input };
      const after = { tool: "read", sessionID: "s1", id: "c1", input, status: "completed", result };
      const snapshot = JSON.stringify([before, after]);

      await hooks["execute.before"]!(before);
      await hooks["execute.after"]!(after);

      expect(JSON.stringify([before, after])).toBe(snapshot);
      const [record] = await readSessionRecords(`${dir}/out`, "s1");
      expect(record).toMatchObject({ filePath: ".ai/x.md", requestedRange: { offset: 3, limit: 4 } });
      expect(JSON.stringify(record)).not.toContain("FILE CONTENTS");
    }));

  it("swallows store failures so the agent is unaffected", () =>
    withTempDir(async (dir) => {
      // dataDir points below a regular file, so every append fails.
      const { ctx, hooks } = fakeContext(dir, { dataDir: "package.json/sub" });
      await (await import("node:fs/promises")).writeFile(`${dir}/package.json`, "{}");
      await plugin.setup(ctx);
      await hooks["execute.before"]!({ tool: "read", sessionID: "s", id: "c", input: { path: "AGENTS.md" } });
      await expect(
        hooks["execute.after"]!({ tool: "read", sessionID: "s", id: "c", status: "completed" }),
      ).resolves.toBeUndefined();
    }));
});

describe("plugin RPC", () => {
  it("serves coverage and previews, and announces each recorded read", () =>
    withTempDir(async (dir) => {
      await mkdir(`${dir}/.ai`);
      await writeFile(`${dir}/.ai/x.md`, ["one", "two", "three", ""].join("\n"));
      const { ctx, hooks, rpc } = fakeContext(dir, {}, true);
      await plugin.setup(ctx);
      expect(rpc.id).toBe("context-inspector");

      const input = { path: ".ai/x.md", offset: 2, limit: 1 };
      await hooks["execute.before"]!({ tool: "read", sessionID: "s1", id: "c1", input });
      await hooks["execute.after"]!({ tool: "read", sessionID: "s1", id: "c1", input, status: "completed" });
      expect(rpc.emitted).toEqual([["read", { sessionID: "s1", filePath: ".ai/x.md" }]]);

      const report = (await rpc.handlers.coverage!({ sessionID: "s1" })) as ICoverageReport;
      expect(report.files.find((f) => f.filePath === ".ai/x.md")).toMatchObject({
        status: ECoverageStatus.Partial,
        ranges: [{ start: 2, end: 2 }],
      });
      expect(await rpc.handlers.preview!({ sessionID: "s1", filePath: ".ai/x.md" })).toMatchObject({
        found: true,
        preview: { lines: ["one", "two", "three"] },
      });
      expect(await rpc.handlers.preview!({ sessionID: "s1", filePath: "package.json" })).toEqual({ found: false });
    }));
});

describe("plugin RPC analysis", () => {
  it("sends the prompt to the configured model and returns its answer", () =>
    withTempDir(async (dir) => {
      await writeFile(`${dir}/AGENTS.md`, "# Agents");
      const calls: { prompt: string; model?: unknown }[] = [];
      const { ctx, rpc } = fakeContext(dir, { analysis: { model: "anthropic/claude-x#high" } }, true, async (input) => {
        calls.push(input);
        return { text: "looks fine" };
      });
      await plugin.setup(ctx);
      expect(await rpc.handlers.analyzeSession!({ sessionID: "s1", task: ["ship it"] })).toEqual({ ok: true, text: "looks fine" });
      expect(calls[0]!.prompt).toContain("ship it");
      expect(calls[0]!.model).toEqual({ providerID: "anthropic", id: "claude-x", variant: "high" });
      expect(await rpc.handlers.reviewProject!({})).toEqual({ ok: true, text: "looks fine", sessionCount: 0 });
    }));

  it("reports model failures as data instead of throwing", () =>
    withTempDir(async (dir) => {
      await writeFile(`${dir}/AGENTS.md`, "# Agents");
      const { ctx, rpc } = fakeContext(dir, {}, true, async () => {
        throw new Error("no provider configured");
      });
      await plugin.setup(ctx);
      expect(await rpc.handlers.analyzeSession!({ sessionID: "s1", task: [] })).toEqual({
        ok: false,
        error: "no provider configured",
      });
    }));
});

describe("parseModelRef", () => {
  it("parses provider/model and an optional variant", () => {
    expect(parseModelRef("openai/gpt-x")).toEqual({ providerID: "openai", id: "gpt-x" });
    expect(parseModelRef("p/org/model#v")).toEqual({ providerID: "p", id: "org/model", variant: "v" });
    expect(parseModelRef("no-slash")).toBeUndefined();
    expect(parseModelRef(3)).toBeUndefined();
  });
});

describe("resolveOptions", () => {
  it("applies defaults and rejects malformed values", () => {
    const o = resolveOptions({ contextPaths: [1], tools: "read" }, "/p");
    expect(o.contextPaths).toEqual(["AGENTS.md", ".ai/**"]);
    expect(o.tools).toEqual(["read"]);
    expect(o.dataDir).toBe(path.resolve("/p", ".opencode/context-inspector"));
    expect(o.autoLoaded).toEqual(["AGENTS.md"]);
    expect(o.analysis).toEqual({ includeContent: false });
  });
});
