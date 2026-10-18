import { writeFile } from "node:fs/promises";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { SessionRevisionTracker } from "../src/evaluation/session-revisions.js";
import { ERevisionCapture, ERevisionState } from "../src/evaluation/types.js";
import { makeHarness, seedProject } from "./evaluation-helpers.js";
import { withTempDir } from "./helpers.js";

describe("SessionRevisionTracker", () => {
  it("records the revision at the first request, including a session that never reads", async () => {
    await withTempDir(async (dir) => {
      const h = makeHarness(dir);
      await seedProject(h);
      await h.start("s1");
      const record = await h.store.getSessionRecord("s1");
      expect(record).toMatchObject({ capture: ERevisionCapture.FirstRequest, models: ["mock/scripted"], agents: ["build"], environment: "env1" });
      expect(record?.startRevisionId).toBe((await h.snapshotter.current()).id);
      expect((await h.groups.revision("s1")).state).toBe(ERevisionState.Stable);
    });
  });

  it("gives sessions on identical context the same revision and records the snapshot it points to", async () => {
    await withTempDir(async (dir) => {
      const h = makeHarness(dir);
      await seedProject(h);
      await h.start("a");
      await h.start("b");
      const [a, b] = await Promise.all([h.groups.revision("a"), h.groups.revision("b")]);
      expect(a.startRevisionId).toBe(b.startRevisionId);
      expect(await h.store.getSnapshot(a.startRevisionId!)).toBeDefined();
    });
  });

  it("keeps a prompt-time snapshot provisional and uses it only once the first request confirms a new session", async () => {
    await withTempDir(async (dir) => {
      const h = makeHarness(dir);
      await seedProject(h);
      await h.tracker.observe({ sessionID: "p", source: "prompt" });
      expect(await h.store.getSessionRecord("p")).toBeUndefined();
      await h.tracker.observe({ sessionID: "p", source: "context", priorTurns: false });
      expect((await h.store.getSessionRecord("p"))?.capture).toBe(ERevisionCapture.Prompt);
    });
  });

  it("treats a change between the prompt and the first request as mixed", async () => {
    await withTempDir(async (dir) => {
      const h = makeHarness(dir);
      await seedProject(h);
      await h.tracker.observe({ sessionID: "p", source: "prompt" });
      await h.write(".ai/style.md", "# Style\nchanged\n");
      await h.tracker.observe({ sessionID: "p", source: "context", priorTurns: false });
      expect((await h.groups.revision("p")).state).toBe(ERevisionState.Mixed);
    });
  });

  it("does not invent a start for a session first seen with history, or a prompt that no request followed", async () => {
    await withTempDir(async (dir) => {
      const h = makeHarness(dir);
      await seedProject(h);
      await h.mark("late");
      await h.request("late");
      const late = await h.groups.revision("late");
      expect(late.state).toBe(ERevisionState.Unknown);
      expect(late.startRevisionId).toBeUndefined();
      expect((await h.store.getSessionRecord("late"))?.capture).toBe(ERevisionCapture.Late);

      await h.mark("ghost");
      await h.tracker.observe({ sessionID: "ghost", source: "prompt" });
      expect((await h.groups.revision("ghost")).state).toBe(ERevisionState.Unknown);
    });
  });

  it("detects a context change during the session and does not misreport it as clean", async () => {
    await withTempDir(async (dir) => {
      const h = makeHarness(dir);
      await seedProject(h);
      await h.start("m");
      await h.request("m");
      expect((await h.groups.revision("m")).state).toBe(ERevisionState.Stable);
      await h.write("AGENTS.md", "# Agents\nedited by the agent\n");
      await h.request("m");
      const revision = await h.groups.revision("m");
      expect(revision.state).toBe(ERevisionState.Mixed);
      expect(revision.revisionIds).toHaveLength(2);
      expect(revision.startRevisionId).toBe(revision.revisionIds[0]);
    });
  });

  it("detects added and deleted context files mid-session", async () => {
    await withTempDir(async (dir) => {
      const h = makeHarness(dir);
      await seedProject(h);
      await h.start("m");
      await h.write(".ai/extra.md", "x");
      await h.request("m");
      expect((await h.groups.revision("m")).state).toBe(ERevisionState.Mixed);
    });
  });

  it("writes nothing when a later request sees the same revision and model", async () => {
    await withTempDir(async (dir) => {
      const h = makeHarness(dir);
      await seedProject(h);
      await h.start("s");
      const file = path.join(h.dataDir, "evaluation", "sessions", "s.json");
      await writeFile(file, "sentinel");
      await h.request("s");
      const { readFile } = await import("node:fs/promises");
      expect(await readFile(file, "utf8")).toBe("sentinel");
    });
  });

  it("recovers a session's record after a restart and keeps judging against its original start", async () => {
    await withTempDir(async (dir) => {
      const h = makeHarness(dir);
      await seedProject(h);
      await h.start("s");
      const restarted = new SessionRevisionTracker(h.store, h.snapshotter, "env1", h.clock);
      await h.write(".ai/style.md", "# Style\nnew\n");
      await restarted.observe({ sessionID: "s", source: "context", priorTurns: true });
      expect((await h.groups.revision("s")).state).toBe(ERevisionState.Mixed);
    });
  });

  it("keeps concurrent sessions apart", async () => {
    await withTempDir(async (dir) => {
      const h = makeHarness(dir);
      await seedProject(h);
      await Promise.all(["a", "b", "c", "d"].map((id) => h.start(id)));
      await h.write(".ai/style.md", "# Style\nchanged\n");
      await Promise.all(["a", "c"].map((id) => h.request(id)));
      const states = await Promise.all(["a", "b", "c", "d"].map(async (id) => (await h.groups.revision(id)).state));
      expect(states).toEqual([ERevisionState.Mixed, ERevisionState.Stable, ERevisionState.Mixed, ERevisionState.Stable]);
    });
  });

  it("treats a subagent that saw a different revision as mixing the group, and a subagent without data as unknown", async () => {
    await withTempDir(async (dir) => {
      const h = makeHarness(dir);
      await seedProject(h);
      await h.start("lead");
      await h.start("sub", "lead");
      expect((await h.groups.revision("lead")).state).toBe(ERevisionState.Stable);
      await h.write(".ai/style.md", "# Style\nchanged\n");
      await h.start("sub2", "lead");
      expect((await h.groups.revision("lead")).state).toBe(ERevisionState.Mixed);
      await h.mark("sub3", "lead");
      expect((await h.groups.revision("lead")).state).toBe(ERevisionState.Unknown);
    });
  });

  it("records models and agents seen without duplicating them", async () => {
    await withTempDir(async (dir) => {
      const h = makeHarness(dir);
      await seedProject(h);
      await h.start("s");
      await h.request("s", { model: "mock/other", agent: "plan" });
      await h.request("s", { model: "mock/other", agent: "plan" });
      expect(await h.store.getSessionRecord("s")).toMatchObject({ models: ["mock/scripted", "mock/other"], agents: ["build", "plan"] });
    });
  });

  it("reads old read logs and sessions without revision data as unknown", async () => {
    await withTempDir(async (dir) => {
      const h = makeHarness(dir);
      await seedProject(h);
      await h.read("historic", "AGENTS.md");
      const revision = await h.groups.revision("historic");
      expect(revision.state).toBe(ERevisionState.Unknown);
      expect(revision.reason).toContain("no revision recorded");
    });
  });
});
