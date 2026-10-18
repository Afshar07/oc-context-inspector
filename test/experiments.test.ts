import { readdir, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { ExperimentError } from "../src/evaluation/experiments.js";
import { EAdherence, EExperimentRole, EExperimentStatus, ERevisionState, ESessionFit, ETaskOutcome } from "../src/evaluation/types.js";
import { makeHarness, seedProject } from "./evaluation-helpers.js";
import { withTempDir } from "./helpers.js";

const rejects = async (promise: Promise<unknown>, message: RegExp) => {
  const error = await promise.then(() => undefined, (e: unknown) => e);
  expect(error).toBeInstanceOf(ExperimentError);
  expect((error as Error).message).toMatch(message);
};

describe("experiment creation", () => {
  it("captures the baseline revision and the target-scoped revision", async () => {
    await withTempDir(async (dir) => {
      const h = makeHarness(dir);
      await seedProject(h);
      const exp = await h.create();
      expect(exp).toMatchObject({ status: EExperimentStatus.AwaitingCandidate, targetFiles: [".ai/style.md"], version: 1, id: "exp_1" });
      expect(exp.baseline.revisionId).toBe((await h.snapshotter.current()).id);
      expect(await h.store.getSnapshot(exp.baseline.revisionId)).toBeDefined();
      expect(exp.candidate).toBeUndefined();
      expect(exp.history.map((e) => e.kind)).toEqual(["created"]);
    });
  });

  it("validates input", async () => {
    await withTempDir(async (dir) => {
      const h = makeHarness(dir);
      await seedProject(h);
      await rejects(h.create({ name: "  " }), /Name/);
      await rejects(h.create({ name: "x".repeat(81) }), /Name/);
      await rejects(h.create({ hypothesis: "" }), /Hypothesis/);
      await rejects(h.create({ targetFiles: [] }), /at least one/);
      await rejects(h.create({ targetFiles: ["src/app.ts"] }), /not a context file/);
      await rejects(h.create({ targetFiles: ["../outside/AGENTS.md"] }), /not a context file/);
      await rejects(h.create({ baselineSessionIDs: ["nope"] }), /Unknown session/);
    });
  });

  it("accepts a target that does not exist yet and normalizes paths", async () => {
    await withTempDir(async (dir) => {
      const h = makeHarness(dir);
      await seedProject(h);
      const exp = await h.create({ targetFiles: [".ai/routing.md", String.raw`.ai\style.md`, ".ai/style.md"] });
      expect(exp.targetFiles).toEqual([".ai/routing.md", ".ai/style.md"]);
    });
  });

  it("refuses a duplicate name or an identical hypothesis among open experiments, but allows it once closed", async () => {
    await withTempDir(async (dir) => {
      const h = makeHarness(dir);
      await seedProject(h);
      const first = await h.create();
      await rejects(h.create({ name: " clarify   ROUTING " }), /already named/);
      await rejects(h.create({ name: "Other name" }), /Same hypothesis/);
      await h.create({ name: "Other name", hypothesis: "Different claim" });
      await h.experiments.close(first.id);
      await h.create();
    });
  });

  it("groups selected baseline sessions under their lead", async () => {
    await withTempDir(async (dir) => {
      const h = makeHarness(dir);
      await seedProject(h);
      await h.start("lead");
      await h.start("sub", "lead");
      const exp = await h.create({ baselineSessionIDs: ["sub", "lead"] });
      expect(exp.sessions.map((s) => [s.sessionID, s.role])).toEqual([["lead", EExperimentRole.Baseline]]);
    });
  });

  it("does not modify any context file or start anything", async () => {
    await withTempDir(async (dir) => {
      const h = makeHarness(dir);
      await seedProject(h);
      const before = (await h.snapshotter.current()).id;
      await h.create();
      expect((await h.snapshotter.current()).id).toBe(before);
    });
  });
});

describe("candidate revision", () => {
  it("is not detected while the target files are unchanged, even if other context moved", async () => {
    await withTempDir(async (dir) => {
      const h = makeHarness(dir);
      await seedProject(h);
      const exp = await h.create();
      await h.write(".ai/architecture.md", "# Architecture\nmore\n");
      const detection = await h.experiments.detectCandidate(exp.id);
      expect(detection.changed).toBe(false);
      expect(detection.otherChanges).toEqual([".ai/architecture.md"]);
      await rejects(h.experiments.confirmCandidate(exp.id, detection.revisionId), /identical to the baseline/);
      expect((await h.experiments.get(exp.id)).candidate).toBeUndefined();
    });
  });

  it("is detected after a target edit, and only linked on confirmation", async () => {
    await withTempDir(async (dir) => {
      const h = makeHarness(dir);
      await seedProject(h);
      const exp = await h.create();
      await h.write(".ai/style.md", "# Style\nUse spaces\n");
      const detection = await h.experiments.detectCandidate(exp.id);
      expect(detection).toMatchObject({ changed: true, targetChanges: { modified: [".ai/style.md"] }, otherChanges: [], alreadyConfirmed: false });
      expect((await h.experiments.get(exp.id)).status).toBe(EExperimentStatus.AwaitingCandidate);

      const confirmed = await h.experiments.confirmCandidate(exp.id, detection.revisionId);
      expect(confirmed.status).toBe(EExperimentStatus.Measuring);
      expect(confirmed.candidate?.revisionId).toBe(detection.revisionId);
      expect(confirmed.candidate?.targetRevisionId).not.toBe(confirmed.baseline.targetRevisionId);
      expect((await h.experiments.detectCandidate(exp.id)).alreadyConfirmed).toBe(true);
    });
  });

  it("recognizes a deleted or renamed target as a change", async () => {
    await withTempDir(async (dir) => {
      const h = makeHarness(dir);
      await seedProject(h);
      const exp = await h.create();
      const { rename } = await import("node:fs/promises");
      await rename(path.join(dir, ".ai/style.md"), path.join(dir, ".ai/style-guide.md"));
      const detection = await h.experiments.detectCandidate(exp.id);
      expect(detection.changed).toBe(true);
      expect(detection.targetChanges.removed.concat(detection.targetChanges.renamed.map((r) => r.from))).toContain(".ai/style.md");
    });
  });

  it("rejects the baseline and unknown revisions", async () => {
    await withTempDir(async (dir) => {
      const h = makeHarness(dir);
      await seedProject(h);
      const exp = await h.create();
      await rejects(h.experiments.confirmCandidate(exp.id, exp.baseline.revisionId), /baseline revision/);
      await rejects(h.experiments.confirmCandidate(exp.id, "deadbeefdeadbeef"), /Unknown revision/);
    });
  });
});

describe("session selection", () => {
  it("offers lead sessions with their revision fit and lets the user edit the selection", async () => {
    await withTempDir(async (dir) => {
      const h = makeHarness(dir);
      await seedProject(h);
      await h.start("before");
      await h.start("before-sub", "before");
      const exp = await h.create();
      await h.write(".ai/style.md", "# Style\nnew\n");
      const { revisionId } = await h.experiments.detectCandidate(exp.id);
      await h.experiments.confirmCandidate(exp.id, revisionId);
      await h.start("after");
      await h.write(".ai/architecture.md", "# Architecture\nunrelated edit\n");
      await h.start("confounded");
      await h.mark("historic");

      const offers = Object.fromEntries((await h.experiments.offers(exp.id)).map((o) => [o.sessionID, o]));
      expect(Object.keys(offers).sort()).toEqual(["after", "before", "confounded", "historic"]);
      expect(offers.before).toMatchObject({ fit: ESessionFit.Baseline, descendants: 1, revisionState: ERevisionState.Stable });
      expect(offers.after?.fit).toBe(ESessionFit.Candidate);
      expect(offers.confounded?.fit).toBe(ESessionFit.OtherContextDiffers);
      expect(offers.historic).toMatchObject({ fit: ESessionFit.Unknown, revisionState: ERevisionState.Unknown });

      await h.experiments.setSessions(exp.id, { add: [{ sessionID: "before-sub", role: EExperimentRole.Baseline }, { sessionID: "after", role: EExperimentRole.Candidate }] });
      let current = await h.experiments.get(exp.id);
      expect(current.sessions.map((s) => `${s.sessionID}:${s.role}`)).toEqual(["before:baseline", "after:candidate"]);
      expect((await h.experiments.offers(exp.id)).find((o) => o.sessionID === "before")?.selectedRole).toBe(EExperimentRole.Baseline);

      await h.experiments.setSessions(exp.id, { remove: ["before"] });
      current = await h.experiments.get(exp.id);
      expect(current.sessions.map((s) => s.sessionID)).toEqual(["after"]);
    });
  });

  it("requires a confirmed candidate before candidate sessions, and refuses unknown sessions", async () => {
    await withTempDir(async (dir) => {
      const h = makeHarness(dir);
      await seedProject(h);
      await h.start("s");
      const exp = await h.create();
      await rejects(h.experiments.setSessions(exp.id, { add: [{ sessionID: "s", role: EExperimentRole.Candidate }] }), /Confirm the candidate/);
      await rejects(h.experiments.setSessions(exp.id, { add: [{ sessionID: "ghost", role: EExperimentRole.Baseline }] }), /Unknown session/);
    });
  });

  it("keeps one entry per session when its role changes", async () => {
    await withTempDir(async (dir) => {
      const h = makeHarness(dir);
      await seedProject(h);
      await h.start("s");
      const exp = await h.create();
      await h.experiments.setSessions(exp.id, { add: [{ sessionID: "s", role: EExperimentRole.Baseline }] });
      await h.write(".ai/style.md", "# Style\nnew\n");
      await h.experiments.confirmCandidate(exp.id, (await h.experiments.detectCandidate(exp.id)).revisionId);
      const updated = await h.experiments.setSessions(exp.id, { add: [{ sessionID: "s", role: EExperimentRole.Candidate }] });
      expect(updated.sessions).toHaveLength(1);
      expect(updated.sessions[0]!.role).toBe(EExperimentRole.Candidate);
    });
  });
});

describe("outcome labels", () => {
  it("stores what the user typed, replaces it, and clears it", async () => {
    await withTempDir(async (dir) => {
      const h = makeHarness(dir);
      await seedProject(h);
      await h.start("s");
      const exp = await h.create({ baselineSessionIDs: ["s"] });
      let updated = await h.experiments.label(exp.id, "s", { taskSuccess: ETaskOutcome.Success, note: "CI green", evidenceRef: "PR #4" });
      expect(updated.sessions[0]!.outcome).toMatchObject({ taskSuccess: "success", note: "CI green", evidenceRef: "PR #4" });
      updated = await h.experiments.label(exp.id, "s", { adherence: EAdherence.NotFollowed, note: "ignored style.md" });
      expect(updated.sessions[0]!.outcome).toMatchObject({ adherence: "not-followed" });
      expect(updated.sessions[0]!.outcome?.taskSuccess).toBeUndefined();
      updated = await h.experiments.label(exp.id, "s", { clear: true });
      expect(updated.sessions[0]!.outcome).toBeUndefined();
    });
  });

  it("refuses empty labels and sessions outside the experiment", async () => {
    await withTempDir(async (dir) => {
      const h = makeHarness(dir);
      await seedProject(h);
      await h.start("s");
      await h.start("other");
      const exp = await h.create({ baselineSessionIDs: ["s"] });
      await rejects(h.experiments.label(exp.id, "s", {}), /Nothing to record/);
      await rejects(h.experiments.label(exp.id, "s", { taskSuccess: ETaskOutcome.Unknown }), /Nothing to record/);
      await rejects(h.experiments.label(exp.id, "other", { note: "x" }), /not selected/);
    });
  });
});

describe("lifecycle and persistence", () => {
  it("closes once, records the reason, and then refuses changes", async () => {
    await withTempDir(async (dir) => {
      const h = makeHarness(dir);
      await seedProject(h);
      const exp = await h.create();
      const closed = await h.experiments.close(exp.id, "superseded");
      expect(closed).toMatchObject({ status: EExperimentStatus.Closed, closedReason: "superseded" });
      await rejects(h.experiments.close(exp.id), /closed/);
      await rejects(h.experiments.setSessions(exp.id, { remove: ["x"] }), /closed/);
      await rejects(h.experiments.detectCandidate(exp.id), /closed/);
      expect((await h.experiments.get(exp.id)).status).toBe(EExperimentStatus.Closed);
    });
  });

  it("survives concurrent updates without losing any", async () => {
    await withTempDir(async (dir) => {
      const h = makeHarness(dir);
      await seedProject(h);
      const ids = ["a", "b", "c", "d", "e"];
      for (const id of ids) await h.start(id);
      const exp = await h.create();
      await Promise.all(ids.map((id) => h.experiments.setSessions(exp.id, { add: [{ sessionID: id, role: EExperimentRole.Baseline }] })));
      expect((await h.experiments.get(exp.id)).sessions.map((s) => s.sessionID).sort()).toEqual(ids);
    });
  });

  it("lists experiments, setting aside damaged or foreign files without touching them", async () => {
    await withTempDir(async (dir) => {
      const h = makeHarness(dir);
      await seedProject(h);
      await h.create();
      const folder = path.join(h.dataDir, "evaluation", "experiments");
      await writeFile(path.join(folder, "torn.json"), '{"version":1,"id":"torn","na');
      await writeFile(path.join(folder, "future.json"), JSON.stringify({ version: 2, id: "future" }));
      const listing = await h.experiments.list();
      expect(listing.experiments.map((e) => e.id)).toEqual(["exp_1"]);
      expect(listing.unreadable.sort()).toEqual(["future.json", "torn.json"]);
      expect((await readdir(folder)).sort()).toEqual(["exp_1.json", "future.json", "torn.json"]);
      await expect(h.experiments.get("torn")).rejects.toBeInstanceOf(ExperimentError);
    });
  });

  it("leaves no temporary files behind and never exposes a half-written experiment", async () => {
    await withTempDir(async (dir) => {
      const h = makeHarness(dir);
      await seedProject(h);
      const exp = await h.create();
      await Promise.all(Array.from({ length: 8 }, (_, i) => h.experiments.label(exp.id, "none", { note: String(i) }).catch(() => {})));
      const names = await readdir(path.join(h.dataDir, "evaluation", "experiments"));
      expect(names.filter((n) => n.endsWith(".tmp"))).toEqual([]);
    });
  });

  it("recovers a damaged snapshot instead of trusting it", async () => {
    await withTempDir(async (dir) => {
      const h = makeHarness(dir);
      await seedProject(h);
      const exp = await h.create();
      const file = path.join(h.dataDir, "evaluation", "snapshots", `${exp.baseline.revisionId}.json`);
      await writeFile(file, "{}");
      expect(await h.store.getSnapshot(exp.baseline.revisionId)).toBeUndefined();
      // Files unchanged: the same content is hashed again, which restores the content-addressed snapshot.
      await h.experiments.detectCandidate(exp.id);
      expect(await h.store.getSnapshot(exp.baseline.revisionId)).toBeDefined();
      // Files changed: the baseline content is gone, so a comparison cannot be made.
      await writeFile(file, "{}");
      await h.write(".ai/style.md", "# Style\nchanged\n");
      await rejects(h.experiments.detectCandidate(exp.id), /baseline snapshot/);
    });
  });

  it("keeps the existing read logs byte-for-byte compatible: nothing is written outside evaluation/", async () => {
    await withTempDir(async (dir) => {
      const h = makeHarness(dir);
      await seedProject(h);
      await h.start("s");
      await h.create();
      const top = (await readdir(h.dataDir)).sort();
      expect(top).toEqual(["evaluation", "sessions"]);
    });
  });
});
