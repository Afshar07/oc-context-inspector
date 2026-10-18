import { mkdir, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import plugin, { readSessionRecords } from "../src/index.js";
import { SessionRegistry } from "../src/sessions.js";
import { ContextReadTracker } from "../src/tracker.js";
import { ContextPathMatcher, DEFAULT_CONTEXT_PATHS } from "../src/matcher.js";
import {
  EDeliverySource,
  ESessionLineage,
  ESessionTracking,
  type ICoverageReport,
  type IContextReadRecord,
  type ISessionObserver,
} from "../src/types.js";
import { MemoryStore, ROOT, StepClock, withTempDir } from "./helpers.js";

const header = (text: string) => [{ type: "text", text }];
const page = (offset: number, count: number, more: boolean) => ({
  output: { type: "text-page", content: Array.from({ length: count }, (_, i) => `l${offset + i}`).join("\n"), offset, truncated: more },
  content: header(`Read file .ai/a.md, lines ${offset}-${offset + count - 1}\n...`),
  metadata: { truncated: more },
});

function newTracker(store: MemoryStore, extra: ConstructorParameters<typeof ContextReadTracker>[4] = {}) {
  return new ContextReadTracker(new ContextPathMatcher(ROOT, DEFAULT_CONTEXT_PATHS), new Set(["read"]), store, new StepClock(), {
    fingerprint: async () => ({ mtimeMs: 1000, sizeBytes: 77 }),
    ...extra,
  });
}

describe("ContextReadTracker attribution and delivery", () => {
  it("records the agent, message, lineage, delivered lines and file fingerprint", async () => {
    const store = new MemoryStore();
    const observer: ISessionObserver = { observe: async () => ({ lineage: ESessionLineage.Child, parentSessionID: "lead-s" }) };
    const tracker = newTracker(store, { sessions: observer });
    const input = { path: ".ai/a.md", offset: 10, limit: 20 };
    tracker.onBefore({ tool: "read", sessionID: "sub-s", id: "call-1", input, agent: "explore", messageID: "msg-1" });
    await tracker.onAfter({ tool: "read", sessionID: "sub-s", id: "call-1", status: "completed", agent: "explore", messageID: "msg-1", result: page(10, 20, true) });
    expect(store.records[0]).toMatchObject({
      sessionID: "sub-s",
      callID: "call-1",
      agentID: "explore",
      messageID: "msg-1",
      parentSessionID: "lead-s",
      lineage: ESessionLineage.Child,
      requestedRange: { offset: 10, limit: 20 },
      delivered: { source: EDeliverySource.Header, range: { start: 10, end: 29 }, lineCount: 20, reachedEof: false },
      fileAtRead: { mtimeMs: 1000, sizeBytes: 77 },
    });
  });

  it("omits what it does not know instead of guessing", async () => {
    const store = new MemoryStore();
    const tracker = newTracker(store, { fingerprint: async () => undefined });
    tracker.onBefore({ tool: "read", sessionID: "s", id: "c", input: { path: "AGENTS.md" } });
    await tracker.onAfter({ tool: "read", sessionID: "s", id: "c", status: "completed", result: {} });
    const [record] = store.records;
    expect(record).toBeDefined();
    for (const key of ["agentID", "messageID", "parentSessionID", "lineage", "delivered", "fileAtRead"]) {
      expect(record).not.toHaveProperty(key);
    }
  });

  it("records the lineage as unknown when the session lookup fails, and still records the read", async () => {
    const store = new MemoryStore();
    const tracker = newTracker(store, { sessions: { observe: async () => Promise.reject(new Error("down")) } });
    tracker.onBefore({ tool: "read", sessionID: "s", id: "c", input: { path: "AGENTS.md" }, agent: "build" });
    await tracker.onAfter({ tool: "read", sessionID: "s", id: "c", status: "completed", agent: "build" });
    expect(store.records[0]).toMatchObject({ agentID: "build" });
    expect(store.records[0]).not.toHaveProperty("lineage");
  });

  it("does not store delivery for a failed read, nor any file contents", async () => {
    const store = new MemoryStore();
    const tracker = newTracker(store);
    tracker.onBefore({ tool: "read", sessionID: "s", id: "c", input: { path: ".ai/a.md" } });
    await tracker.onAfter({ tool: "read", sessionID: "s", id: "c", status: "error", error: { message: "File not found" }, result: page(1, 2, false) });
    expect(store.records[0]).toMatchObject({ status: "error" });
    expect(store.records[0]).not.toHaveProperty("delivered");

    tracker.onBefore({ tool: "read", sessionID: "s", id: "d", input: { path: ".ai/a.md" } });
    await tracker.onAfter({ tool: "read", sessionID: "s", id: "d", status: "completed", result: { ...page(1, 2, false), output: { type: "text-page", content: "TOP SECRET", offset: 1 } } });
    expect(JSON.stringify(store.records)).not.toContain("TOP SECRET");
  });

  it("keeps interleaved calls of concurrent agents apart", async () => {
    const store = new MemoryStore();
    const tracker = newTracker(store);
    const calls = [
      ["s1", "c1", "build"],
      ["s2", "c1", "explore"], // same call ID in another session
      ["s1", "c2", "build"],
    ] as const;
    for (const [sessionID, id, agent] of calls) tracker.onBefore({ tool: "read", sessionID, id, input: { path: "AGENTS.md" }, agent });
    for (const [sessionID, id, agent] of [...calls].reverse()) await tracker.onAfter({ tool: "read", sessionID, id, status: "completed", agent });
    expect(store.records.map((r) => [r.sessionID, r.callID, r.agentID]).sort()).toEqual([
      ["s1", "c1", "build"],
      ["s1", "c2", "build"],
      ["s2", "c1", "explore"],
    ]);
  });

  it("observes the session for any tool call, read or not", () => {
    const seen: string[] = [];
    const tracker = newTracker(new MemoryStore(), { sessions: { observe: async (id) => (seen.push(id), {}) } });
    tracker.onBefore({ tool: "bash", sessionID: "talker", id: "c", input: { command: "ls" } });
    tracker.onBefore({ tool: "read", sessionID: "reader", id: "c", input: { path: "src/app.ts" } }); // not context
    expect(seen).toEqual(["talker", "reader"]);
  });

  it("never mutates the events it is given", async () => {
    const tracker = newTracker(new MemoryStore());
    const before = { tool: "read", sessionID: "s", id: "c", input: { path: ".ai/a.md", offset: 2 }, agent: "build", messageID: "m" };
    const after = { tool: "read", sessionID: "s", id: "c", status: "completed" as const, agent: "build", messageID: "m", result: page(2, 3, false) };
    const snapshot = JSON.stringify([before, after]);
    tracker.onBefore(before);
    await tracker.onAfter(after);
    expect(JSON.stringify([before, after])).toBe(snapshot);
  });
});

type Hook = (event: Record<string, unknown>) => unknown;

/** Stand-in for the V2 plugin context with session lookup and the session `context` hook. */
function fakeContext(directory: string, parents: Record<string, string | undefined>, options: Record<string, unknown> = {}) {
  const hooks: Record<string, Hook> = {};
  const sessionHooks: Record<string, Hook> = {};
  const ctx = {
    options,
    location: { directory },
    generate: { text: async () => ({ text: "" }) },
    model: { default: async () => ({ data: { providerID: "p", id: "m" } }) },
    tool: { hook: async (name: string, cb: Hook) => ((hooks[name] = cb), { dispose: async () => {} }) },
    session: {
      get: async ({ sessionID }: { sessionID: string }) => ({ id: sessionID, ...(parents[sessionID] && { parentID: parents[sessionID] }) }),
      hook: async (name: string, cb: Hook) => ((sessionHooks[name] = cb), { dispose: async () => {} }),
    },
  };
  return { ctx: ctx as never, hooks, sessionHooks };
}

describe("plugin session tracking", () => {
  it("observes a session that only talks (no tool call) through the session context hook", () =>
    withTempDir(async (dir) => {
      const { ctx, sessionHooks } = fakeContext(dir, {}, { dataDir: "out" });
      await plugin.setup(ctx);
      expect(Object.keys(sessionHooks)).toEqual(["context"]);
      await sessionHooks.context!({ sessionID: "chatty", agent: "build", system: [], messages: [] });
      await new Promise((r) => setTimeout(r, 50));
      const registry = new SessionRegistry(path.join(dir, "out"));
      expect(await registry.get("chatty")).toMatchObject({ tracking: ESessionTracking.Observed, lineage: ESessionLineage.Root });
      expect(await readSessionRecords(path.join(dir, "out"), "chatty")).toEqual([]);
    }));

  it("attributes reads end to end: a subagent's read carries its parent, its agent and the delivered range", () =>
    withTempDir(async (dir) => {
      await mkdir(path.join(dir, ".ai"), { recursive: true });
      await writeFile(path.join(dir, ".ai/a.md"), "one\ntwo\nthree\n");
      const { ctx, hooks } = fakeContext(dir, { sub: "lead" }, { dataDir: "out" });
      await plugin.setup(ctx);
      const input = { path: ".ai/a.md" };
      const result = { output: { type: "file", content: "one\ntwo\nthree\n" }, content: header("Read file .ai/a.md, lines 1-3\n1: one"), metadata: { truncated: false } };
      for (const [sessionID, agent] of [["lead", "build"], ["sub", "explore"]] as const) {
        await hooks["execute.before"]!({ tool: "read", sessionID, agent, messageID: "m", id: "c1", input });
        await hooks["execute.after"]!({ tool: "read", sessionID, agent, messageID: "m", id: "c1", input, status: "completed", result });
      }
      const dataDir = path.join(dir, "out");
      const [lead] = await readSessionRecords(dataDir, "lead");
      const [sub] = await readSessionRecords(dataDir, "sub");
      expect(lead).toMatchObject({ agentID: "build", lineage: ESessionLineage.Root, delivered: { range: { start: 1, end: 3 }, fileLines: 3 } });
      expect(lead).not.toHaveProperty("parentSessionID");
      expect(sub).toMatchObject({ agentID: "explore", lineage: ESessionLineage.Child, parentSessionID: "lead", sessionID: "sub", callID: "c1" });
      expect(sub?.fileAtRead?.sizeBytes).toBe(14);
    }));

  it("survives a context without session support", () =>
    withTempDir(async (dir) => {
      const { ctx } = fakeContext(dir, {});
      (ctx as unknown as { session: unknown }).session = undefined;
      await expect(plugin.setup(ctx)).resolves.toBeUndefined();
    }));

  it("writes the tracking start once, even when setup runs repeatedly", () =>
    withTempDir(async (dir) => {
      const { ctx } = fakeContext(dir, {}, { dataDir: "out" });
      await plugin.setup(ctx);
      await plugin.setup(ctx);
      await new Promise((r) => setTimeout(r, 50));
      const registry = new SessionRegistry(path.join(dir, "out"));
      expect(await registry.trackingStartedAt()).toBeDefined();
    }));

  it("RPC coverage tells a lead its subagent's reads and reports the tracking state", () =>
    withTempDir(async (dir) => {
      await mkdir(path.join(dir, ".ai"), { recursive: true });
      await writeFile(path.join(dir, ".ai/a.md"), "one\ntwo\n");
      const rpc = { handlers: {} as Record<string, (i: Record<string, unknown>) => Promise<unknown>>, emitted: [] as unknown[][] };
      const { ctx: base, hooks } = fakeContext(dir, { sub: "lead" }, { dataDir: "out" });
      (base as unknown as { rpc: unknown }).rpc = {
        register: async (_d: unknown, handlers: typeof rpc.handlers) => {
          rpc.handlers = handlers;
          return { dispose: async () => {}, events: { emit: async (...a: unknown[]) => void rpc.emitted.push(a) } };
        },
      };
      await plugin.setup(base);
      const input = { path: ".ai/a.md" };
      for (const sessionID of ["lead", "sub"]) {
        await hooks["execute.before"]!({ tool: "read", sessionID, agent: "a", id: "c", input });
        await hooks["execute.after"]!({ tool: "read", sessionID, agent: "a", id: "c", input, status: "completed", result: {} });
      }
      // The sub's read announces its ancestors so the lead's sidebar refreshes.
      expect(rpc.emitted.map((e) => e[1])).toEqual([
        { sessionID: "lead", filePath: ".ai/a.md", ancestors: [] },
        { sessionID: "sub", filePath: ".ai/a.md", ancestors: ["lead"] },
      ]);
      const report = (await rpc.handlers.coverage!({ sessionID: "lead" })) as ICoverageReport;
      expect(report.tracking).toBe(ESessionTracking.Observed);
      expect(report.files.find((f) => f.filePath === ".ai/a.md")?.agents.map((a) => [a.sessionID, a.depth])).toEqual([["lead", 0], ["sub", 1]]);
    }));
});

export type { IContextReadRecord };
