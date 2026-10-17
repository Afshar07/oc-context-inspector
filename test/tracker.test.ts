import { describe, expect, it } from "vitest";
import { EReadStatus } from "../src/types.js";
import { MemoryStore, makeTracker } from "./helpers.js";

const before = (sessionID: string, id: string, input: unknown, tool = "read") => ({
  tool,
  sessionID,
  id,
  input,
});
const done = (sessionID: string, id: string, tool = "read") => ({
  tool,
  sessionID,
  id,
  status: "completed" as const,
});

describe("read tracking", () => {
  it("records a context read with session, call, path, range and timestamps", async () => {
    const store = new MemoryStore();
    const tracker = makeTracker(store);
    tracker.onBefore(before("ses_1", "call_1", { path: ".ai/rules.md", offset: 10, limit: 20 }));
    await tracker.onAfter(done("ses_1", "call_1"));

    expect(store.records).toEqual([
      {
        sessionID: "ses_1",
        callID: "call_1",
        tool: "read",
        filePath: ".ai/rules.md",
        matchedPattern: ".ai/**",
        requestedRange: { offset: 10, limit: 20 },
        status: EReadStatus.Completed,
        startedAt: "2026-01-01T00:00:00.000Z",
        completedAt: "2026-01-01T00:00:01.000Z",
      },
    ]);
  });

  it("accepts the filePath argument spelling and omits absent range fields", async () => {
    const store = new MemoryStore();
    const tracker = makeTracker(store);
    tracker.onBefore(before("s", "c", { filePath: "AGENTS.md" }));
    await tracker.onAfter(done("s", "c"));
    expect(store.records[0]?.requestedRange).toEqual({});
    expect(store.records[0]?.filePath).toBe("AGENTS.md");
  });

  it("ignores non-context files, other tools and malformed input", async () => {
    const store = new MemoryStore();
    const tracker = makeTracker(store);
    const cases: Array<[string, unknown, string?]> = [
      ["1", { path: "src/app.ts" }],
      ["2", { path: "AGENTS.md" }, "bash"],
      ["3", null],
      ["4", "AGENTS.md"],
      ["5", { path: 42 }],
    ];
    for (const [id, input, tool] of cases) {
      tracker.onBefore(before("s", id, input, tool));
      await tracker.onAfter(done("s", id, tool));
    }
    expect(store.records).toEqual([]);
  });

  it("ignores non-numeric range values", async () => {
    const store = new MemoryStore();
    const tracker = makeTracker(store);
    tracker.onBefore(before("s", "c", { path: "AGENTS.md", offset: "5", limit: NaN }));
    await tracker.onAfter(done("s", "c"));
    expect(store.records[0]?.requestedRange).toEqual({});
  });

  it("does not mutate the tool input", async () => {
    const tracker = makeTracker(new MemoryStore());
    const input = Object.freeze({ path: "AGENTS.md", offset: 1, limit: 2 });
    const snapshot = JSON.stringify(input);
    expect(() => tracker.onBefore(before("s", "c", input))).not.toThrow();
    expect(JSON.stringify(input)).toBe(snapshot);
  });
});

describe("repeated reads", () => {
  it("keeps one record per call, including identical and differing ranges", async () => {
    const store = new MemoryStore();
    const tracker = makeTracker(store);
    const reads = [
      { path: "AGENTS.md" },
      { path: ".ai/a.md", offset: 1, limit: 10 },
      { path: ".ai/a.md", offset: 1, limit: 10 },
      { path: ".ai/a.md", offset: 11, limit: 10 },
    ];
    for (const [i, input] of reads.entries()) {
      tracker.onBefore(before("s", `c${i}`, input));
      await tracker.onAfter(done("s", `c${i}`));
    }
    expect(store.records.map((r) => [r.callID, r.filePath, r.requestedRange])).toEqual([
      ["c0", "AGENTS.md", {}],
      ["c1", ".ai/a.md", { offset: 1, limit: 10 }],
      ["c2", ".ai/a.md", { offset: 1, limit: 10 }],
      ["c3", ".ai/a.md", { offset: 11, limit: 10 }],
    ]);
  });
});

describe("errors", () => {
  it("records failed reads with a truncated message", async () => {
    const store = new MemoryStore();
    const tracker = makeTracker(store);
    tracker.onBefore(before("s", "c", { path: ".ai/missing.md" }));
    await tracker.onAfter({
      tool: "read",
      sessionID: "s",
      id: "c",
      status: "error",
      error: { message: "x".repeat(500) },
    });
    const [record] = store.records;
    expect(record?.status).toBe(EReadStatus.Error);
    expect(record?.errorMessage).toHaveLength(200);
  });

  it("ignores an after-event with no matching before-event", async () => {
    const store = new MemoryStore();
    await makeTracker(store).onAfter(done("s", "orphan"));
    expect(store.records).toEqual([]);
  });

  it("propagates nothing to the agent when the store fails (caller swallows)", async () => {
    const tracker = makeTracker({
      append: async () => {
        throw new Error("disk full");
      },
    });
    tracker.onBefore(before("s", "c", { path: "AGENTS.md" }));
    await expect(tracker.onAfter(done("s", "c"))).rejects.toThrow("disk full");
  });
});

describe("concurrent sessions", () => {
  it("keeps interleaved sessions separate even with identical call IDs", async () => {
    const store = new MemoryStore();
    const tracker = makeTracker(store);
    tracker.onBefore(before("A", "call_1", { path: "AGENTS.md" }));
    tracker.onBefore(before("B", "call_1", { path: ".ai/b.md", limit: 3 }));
    await tracker.onAfter({ ...done("B", "call_1"), status: "error", error: { message: "boom" } } as never);
    await tracker.onAfter(done("A", "call_1"));

    const byKey = Object.fromEntries(store.records.map((r) => [r.sessionID, r]));
    expect(byKey.A).toMatchObject({ filePath: "AGENTS.md", status: "completed" });
    expect(byKey.B).toMatchObject({ filePath: ".ai/b.md", status: "error", requestedRange: { limit: 3 } });
  });
});
