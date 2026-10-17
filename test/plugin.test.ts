import { describe, expect, it } from "vitest";
import plugin, { readSessionRecords, resolveOptions } from "../src/index.js";
import { withTempDir } from "./helpers.js";

type Hook = (event: Record<string, unknown>) => unknown;

/** Minimal stand-in for the V2 plugin context: just enough to capture tool hooks. */
function fakeContext(directory: string, options: Record<string, unknown> = {}) {
  const hooks: Record<string, Hook> = {};
  const ctx = {
    options,
    location: { directory },
    tool: {
      hook: async (name: string, cb: Hook) => {
        hooks[name] = cb;
        return { dispose: async () => {} };
      },
    },
  };
  return { ctx: ctx as never, hooks };
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

describe("resolveOptions", () => {
  it("applies defaults and rejects malformed values", () => {
    const o = resolveOptions({ contextPaths: [1], tools: "read" }, "/p");
    expect(o.contextPaths).toEqual(["AGENTS.md", ".ai/**"]);
    expect(o.tools).toEqual(["read"]);
    expect(o.dataDir).toBe("/p/.opencode/context-inspector");
  });
});
