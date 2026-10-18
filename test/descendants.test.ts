import { describe, expect, it } from "vitest";
import { formatTimeline } from "../src/analysis.js";
import { ContextInspectorRpc } from "../src/rpc.js";
import { discoverSessions, MAX_DESCENDANT_SESSIONS, type ISessionNode } from "../src/tui/descendants.js";
import { buildTimeline } from "../src/tui/timeline.js";
import { ETimelineSessionState } from "../src/types.js";

const DIR = "/proj";
const assistant = (ms: number, agent: string, tools: readonly unknown[]) => ({
  type: "assistant",
  agent,
  time: { created: ms },
  content: [{ type: "text", text: "done" }, ...tools],
});
const tool = (id: string, name: string, ms: number, input: unknown = {}) => ({
  type: "tool",
  id,
  name,
  time: { created: ms },
  state: { status: "completed", input },
});

/** A delegation tree: parent id -> children. Messages per session; a missing entry fails to load. */
function fake(tree: Record<string, readonly ISessionNode[]>, messages: Record<string, readonly unknown[]>, failList: readonly string[] = []) {
  const listed: string[] = [];
  return {
    listed,
    deps: {
      listChildren: async (parentID: string) => {
        listed.push(parentID);
        if (failList.includes(parentID)) throw new Error("boom");
        return tree[parentID] ?? [];
      },
      loadMessages: async (id: string) => {
        const m = messages[id];
        if (!m) throw new Error("sync failed");
        return m;
      },
    },
  };
}

describe("discoverSessions", () => {
  it("finds a subagent that never read a context file: it edits code", async () => {
    const f = fake(
      { lead: [{ id: "kid", agent: "build" }] },
      { lead: [], kid: [assistant(10, "build", [tool("e1", "edit", 11, { filePath: "src/a.ts", newString: "SECRET" })])] },
    );
    const { sessions, roster } = await discoverSessions("lead", f.deps);
    expect(roster).toMatchObject([{ sessionID: "lead", depth: 0 }, { sessionID: "kid", parentID: "lead", agentID: "build", depth: 1, state: "loaded" }]);
    const { events } = buildTimeline(sessions, DIR);
    expect(events).toMatchObject([{ sessionID: "kid", tool: "edit", path: "src/a.ts" }]);
    expect(JSON.stringify(events)).not.toContain("SECRET");
  });

  it("finds a subagent that only ran a test command", async () => {
    const f = fake(
      { lead: [{ id: "kid", agent: "qa" }] },
      { lead: [], kid: [{ type: "shell", time: { created: 5 }, command: "npm test", status: "exited", exit: 1 }] },
    );
    const { sessions } = await discoverSessions("lead", f.deps);
    expect(buildTimeline(sessions, DIR).events).toMatchObject([{ sessionID: "kid", command: "npm test", exit: 1 }]);
  });

  it("keeps a subagent that only produced a response, as a roster entry", async () => {
    const f = fake({ lead: [{ id: "kid", agent: "explore" }] }, { lead: [], kid: [assistant(5, "explore", [])] });
    const { sessions, roster } = await discoverSessions("lead", f.deps);
    expect(buildTimeline(sessions, DIR).events).toEqual([]);
    expect(roster[1]).toMatchObject({ sessionID: "kid", state: ETimelineSessionState.Loaded, messages: 1 });
    expect(formatTimeline([], { sessionID: "lead", reads: new Map(), omitted: 0, includeCommands: false, sessions: roster })).toBe(
      "Sessions:\n- subagent explore: 1 message",
    );
  });

  it("finds a subagent that read a context file", async () => {
    const f = fake(
      { lead: [{ id: "kid", agent: "explore" }] },
      { lead: [], kid: [assistant(5, "explore", [tool("c1", "read", 6, { path: "/proj/AGENTS.md" })])] },
    );
    const { sessions } = await discoverSessions("lead", f.deps);
    expect(buildTimeline(sessions, DIR).events).toMatchObject([{ sessionID: "kid", path: "AGENTS.md", callID: "c1" }]);
  });

  it("walks concurrent subagents and nested delegation once each", async () => {
    const f = fake(
      {
        lead: [{ id: "a", agent: "x" }, { id: "b", agent: "y" }],
        a: [{ id: "a1", agent: "z" }],
        b: [{ id: "b1" }, { id: "a1", agent: "z" }],
        a1: [{ id: "a2", agent: "w" }],
      },
      { lead: [], a: [], b: [], a1: [], b1: [], a2: [] },
    );
    const { roster } = await discoverSessions("lead", f.deps);
    expect(roster.map((r) => [r.sessionID, r.parentID, r.depth])).toEqual([
      ["lead", undefined, 0],
      ["a", "lead", 1],
      ["b", "lead", 1],
      ["a1", "a", 2],
      ["b1", "b", 2],
      ["a2", "a1", 3],
    ]);
    expect(f.listed.filter((id) => id === "a1")).toHaveLength(1);
  });

  it("survives a cyclic or self-referencing listing", async () => {
    const f = fake({ lead: [{ id: "lead" }, { id: "k" }], k: [{ id: "lead" }, { id: "k" }] }, { lead: [], k: [] });
    const { roster } = await discoverSessions("lead", f.deps);
    expect(roster.map((r) => r.sessionID)).toEqual(["lead", "k"]);
  });

  it("records a child whose messages cannot be loaded instead of omitting it", async () => {
    const f = fake({ lead: [{ id: "ok" }, { id: "bad", agent: "build" }] }, { lead: [], ok: [] });
    const { sessions, roster } = await discoverSessions("lead", f.deps);
    expect(sessions.map((s) => s.sessionID)).toEqual(["lead", "ok"]);
    expect(roster[2]).toMatchObject({ sessionID: "bad", agentID: "build", state: ETimelineSessionState.Unavailable, messages: 0, reason: "message sync failed" });
    const text = formatTimeline([], { sessionID: "lead", reads: new Map(), omitted: 0, includeCommands: false, sessions: roster });
    expect(text).toContain("- subagent build: messages unavailable (message sync failed); its steps are NOT in this timeline");
  });

  it("notes when children of a session could not be listed, and still uses sessions the coverage report knows", async () => {
    const f = fake({}, { lead: [], seen: [] }, ["lead"]);
    const { roster } = await discoverSessions("lead", f.deps, [{ sessionID: "seen", agentID: "explore" }, { sessionID: "lead" }]);
    expect(roster[0]).toMatchObject({ sessionID: "lead", reason: "child sessions could not be listed" });
    expect(roster[1]).toMatchObject({ sessionID: "seen", parentID: "lead", agentID: "explore", depth: 1 });
    expect(roster).toHaveLength(2);
  });

  it("does not duplicate a session found by both the listing and the coverage report", async () => {
    const f = fake({ lead: [{ id: "kid", agent: "build" }] }, { lead: [], kid: [] });
    const { roster } = await discoverSessions("lead", f.deps, [{ sessionID: "kid", agentID: "other", parentSessionID: "lead" }]);
    expect(roster.filter((r) => r.sessionID === "kid")).toHaveLength(1);
    expect(roster[1]!.agentID).toBe("build");
  });

  it("copes with sparse session metadata: no agent, no parent field", async () => {
    const f = fake({ lead: [{ id: "kid" }] }, { lead: [], kid: [] });
    const { roster } = await discoverSessions("lead", f.deps);
    expect(roster[1]).toEqual({ sessionID: "kid", parentID: "lead", depth: 1, state: "loaded", messages: 0 });
  });

  it("bounds a huge tree and says so", async () => {
    const kids = Array.from({ length: MAX_DESCENDANT_SESSIONS + 10 }, (_, i) => ({ id: `k${i}` }));
    const messages = Object.fromEntries([["lead", []], ...kids.map((k) => [k.id, []])]);
    const { roster } = await discoverSessions("lead", fake({ lead: kids }, messages).deps);
    expect(roster).toHaveLength(MAX_DESCENDANT_SESSIONS);
    expect(roster[0]!.reason).toContain("truncated");
  });
});

describe("timeline sessions on the wire", () => {
  it("accepts the roster and stays optional", async () => {
    type Standard = { "~standard": { validate: (v: unknown) => unknown } };
    const validate = async (v: unknown) =>
      ((await (ContextInspectorRpc.methods.analyzeSession.input as unknown as Standard)["~standard"].validate(v)) as { issues?: unknown[] }).issues;
    const base = { sessionID: "s", task: [] };
    const session = { sessionID: "k", parentID: "s", depth: 1, state: "unavailable", messages: 0, reason: "message sync failed" };
    expect(await validate({ ...base, timeline: { events: [], omitted: 0, sessions: [session] } })).toBeUndefined();
    expect(await validate({ ...base, timeline: { events: [], omitted: 0 } })).toBeUndefined();
    expect(await validate({ ...base, timeline: { events: [], omitted: 0, sessions: [{ ...session, state: "bogus" }] } })).toBeDefined();
  });
});
