import { mkdir, readdir, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { SessionObserver, SessionRegistry, startTracking } from "../src/sessions.js";
import { JsonlContextReadStore, readTrackingState, writeSessionMarker } from "../src/store.js";
import { EReadStatus, ESessionLineage, ESessionTracking, type IContextReadRecord } from "../src/types.js";
import { StepClock, withTempDir } from "./helpers.js";

const marker = (sessionID: string, extra: Partial<Parameters<typeof writeSessionMarker>[1]> = {}) => ({
  version: 1 as const,
  sessionID,
  firstObservedAt: "2026-01-01T00:00:00.000Z",
  ...extra,
});

const record = (sessionID: string): IContextReadRecord => ({
  sessionID,
  callID: "c",
  tool: "read",
  filePath: "AGENTS.md",
  matchedPattern: "AGENTS.md",
  requestedRange: {},
  status: EReadStatus.Completed,
  startedAt: "2026-01-01T00:00:00.000Z",
  completedAt: "2026-01-01T00:00:01.000Z",
});

describe("SessionObserver", () => {
  it("marks a session once, however many events and concurrent callers it has", () =>
    withTempDir(async (dir) => {
      let lookups = 0;
      const observer = new SessionObserver(dir, async () => (lookups++, {}), new StepClock());
      const results = await Promise.all(Array.from({ length: 20 }, () => observer.observe("s1")));
      await observer.observe("s1");
      expect(lookups).toBe(1);
      expect(new Set(results.map((r) => r.lineage))).toEqual(new Set([ESessionLineage.Root]));
      expect(await readdir(path.join(dir, "sessions"))).toEqual(["s1.json"]);
    }));

  it("does not double count when two observers (two plugin instances) race", () =>
    withTempDir(async (dir) => {
      const a = new SessionObserver(dir, async () => ({}), new StepClock());
      const b = new SessionObserver(dir, async () => ({}), new StepClock());
      await Promise.all([a.observe("s1"), b.observe("s1"), a.observe("s2"), b.observe("s2")]);
      const sessions = await new SessionRegistry(dir).list();
      expect(sessions.map((s) => s.sessionID)).toEqual(["s1", "s2"]);
      // The first writer's timestamp survives.
      expect(sessions[0]!.firstObservedAt).toBeDefined();
    }));

  it("records the parent of a subagent session and marks a plain session as root", () =>
    withTempDir(async (dir) => {
      const observer = new SessionObserver(dir, async (id) => (id === "child" ? { parentID: "root" } : {}), new StepClock());
      expect(await observer.observe("root")).toEqual({ lineage: ESessionLineage.Root });
      expect(await observer.observe("child")).toEqual({ lineage: ESessionLineage.Child, parentSessionID: "root" });
    }));

  it("leaves the lineage unknown when the lookup fails, and fills it in once it works", () =>
    withTempDir(async (dir) => {
      let healthy = false;
      const observer = new SessionObserver(
        dir,
        async () => {
          if (!healthy) throw new Error("server busy");
          return { parentID: "root" };
        },
        new StepClock(),
      );
      expect(await observer.observe("child")).toEqual({});
      expect((await new SessionRegistry(dir).get("child")).tracking).toBe(ESessionTracking.Observed);
      expect((await new SessionRegistry(dir).get("child")).lineage).toBeUndefined();

      healthy = true;
      expect(await observer.observe("child")).toEqual({ lineage: ESessionLineage.Child, parentSessionID: "root" });
      const after = await new SessionRegistry(dir).get("child");
      expect(after).toMatchObject({ lineage: ESessionLineage.Child, parentSessionID: "root" });
    }));

  it("treats an unknown session (lookup returns nothing) as unresolved, not as root", () =>
    withTempDir(async (dir) => {
      const observer = new SessionObserver(dir, async () => undefined, new StepClock());
      expect(await observer.observe("s")).toEqual({});
    }));
});

describe("writeSessionMarker", () => {
  it("never replaces an existing marker's first-seen time or a known lineage", () =>
    withTempDir(async (dir) => {
      await writeSessionMarker(dir, marker("s", { lineage: ESessionLineage.Child, parentSessionID: "p" }));
      const second = await writeSessionMarker(dir, marker("s", { firstObservedAt: "2030-01-01T00:00:00.000Z", lineage: ESessionLineage.Root }));
      expect(second).toMatchObject({ firstObservedAt: "2026-01-01T00:00:00.000Z", lineage: ESessionLineage.Child, parentSessionID: "p" });
    }));

  it("keeps session IDs from escaping the data directory", () =>
    withTempDir(async (dir) => {
      await writeSessionMarker(dir, marker("../../evil"));
      expect(await readdir(path.join(dir, "sessions"))).toEqual(["______evil.json"]);
    }));
});

describe("SessionRegistry", () => {
  it("distinguishes observed zero-read sessions, reads-only legacy sessions and unobserved ones", () =>
    withTempDir(async (dir) => {
      await writeSessionMarker(dir, marker("zero-reads"));
      await writeSessionMarker(dir, marker("with-reads"));
      const store = new JsonlContextReadStore(dir);
      await store.append(record("with-reads"));
      await store.append(record("legacy"));

      const registry = new SessionRegistry(dir);
      expect((await registry.list()).map((s) => [s.sessionID, s.tracking])).toEqual([
        ["legacy", ESessionTracking.ReadsOnly],
        ["with-reads", ESessionTracking.Observed],
        ["zero-reads", ESessionTracking.Observed],
      ]);
      expect((await registry.get("never-seen")).tracking).toBe(ESessionTracking.Unobserved);
    }));

  it("lists a session once when it has both a marker and records", () =>
    withTempDir(async (dir) => {
      await writeSessionMarker(dir, marker("s"));
      await new JsonlContextReadStore(dir).append(record("s"));
      await new JsonlContextReadStore(dir).append(record("s"));
      expect(await new SessionRegistry(dir).list()).toHaveLength(1);
    }));

  it("is empty for a data directory that does not exist", async () => {
    expect(await new SessionRegistry(path.join("/definitely/not/here")).list()).toEqual([]);
  });

  it("ignores unreadable markers instead of failing", () =>
    withTempDir(async (dir) => {
      await mkdir(path.join(dir, "sessions"));
      await writeFile(path.join(dir, "sessions", "bad.json"), "{not json");
      await writeSessionMarker(dir, marker("good"));
      expect((await new SessionRegistry(dir).list()).map((s) => s.sessionID)).toEqual(["good"]);
    }));

  it("walks nested delegation, depth by depth, and survives cycles", () =>
    withTempDir(async (dir) => {
      await writeSessionMarker(dir, marker("lead", { lineage: ESessionLineage.Root }));
      await writeSessionMarker(dir, marker("sub", { lineage: ESessionLineage.Child, parentSessionID: "lead" }));
      await writeSessionMarker(dir, marker("subsub", { lineage: ESessionLineage.Child, parentSessionID: "sub" }));
      await writeSessionMarker(dir, marker("other", { lineage: ESessionLineage.Root }));
      await writeSessionMarker(dir, marker("loop-a", { parentSessionID: "loop-b" }));
      await writeSessionMarker(dir, marker("loop-b", { parentSessionID: "loop-a" }));

      const registry = new SessionRegistry(dir);
      expect([...(await registry.tree("lead"))]).toEqual([["lead", 0], ["sub", 1], ["subsub", 2]]);
      expect([...(await registry.tree("other"))]).toEqual([["other", 0]]);
      expect(await registry.ancestors("subsub")).toEqual(["sub", "lead"]);
      expect(await registry.ancestors("lead")).toEqual([]);
      expect([...(await registry.tree("loop-a"))].map(([id]) => id).sort()).toEqual(["loop-a", "loop-b"]);
      expect((await registry.ancestors("loop-a")).sort()).toEqual(["loop-b"]);
    }));
});

describe("startTracking", () => {
  it("records when tracking began, once", () =>
    withTempDir(async (dir) => {
      expect(await readTrackingState(dir)).toBeUndefined();
      await startTracking(dir, { now: () => new Date("2026-02-01T00:00:00.000Z") });
      await startTracking(dir, { now: () => new Date("2027-02-01T00:00:00.000Z") });
      expect((await readTrackingState(dir))?.startedAt).toBe("2026-02-01T00:00:00.000Z");
    }));
});
