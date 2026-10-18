import { describe, expect, it } from "vitest";
import { compareGroups, DEFAULT_SETTINGS, isGrounded, overallVerdict, sideContext } from "../src/evaluation/comparison.js";
import { fileCompleteness, measureGroup } from "../src/evaluation/metrics.js";
import {
  EAdherence,
  ECompleteness,
  EExclusionReason,
  EExperimentRole,
  EMissing,
  ERevisionState,
  ETaskOutcome,
  EVerdict,
  type IComparisonContext,
  type IGroupMeasurement,
  type ISessionActivity,
} from "../src/evaluation/types.js";
import { EDeliverySource, EReadStatus, type IContextReadRecord } from "../src/types.js";
import { makeHarness, seedProject, wholeFile, type Harness } from "./evaluation-helpers.js";
import { withTempDir } from "./helpers.js";

const STYLE = ".ai/style.md";
const metric = (result: { metrics: readonly { id: string }[] }, id: string) => result.metrics.find((m) => m.id === id) as import("../src/evaluation/types.js").IMetricComparison;

const activity = (sessionID: string, extra: Partial<ISessionActivity> = {}): ISessionActivity => ({
  sessionID,
  complete: true,
  unavailableSessions: 0,
  actionCount: 0,
  shellRuns: 0,
  shellWithExit: 0,
  shellNonZero: 0,
  verificationRuns: 0,
  verificationWithExit: 0,
  verificationNonZero: 0,
  ...extra,
});

/** Baseline sessions, then a documentation change confirmed as candidate, then candidate sessions. */
async function scenario(h: Harness, opts: { baseline: readonly string[]; candidate: readonly string[]; edit?: () => Promise<void> }) {
  await seedProject(h);
  for (const id of opts.baseline) await h.start(id);
  const exp = await h.create();
  await (opts.edit ?? (() => h.write(STYLE, "# Style\nUse spaces\n")))();
  await h.experiments.confirmCandidate(exp.id, (await h.experiments.detectCandidate(exp.id)).revisionId);
  for (const id of opts.candidate) await h.start(id);
  await h.experiments.setSessions(exp.id, {
    add: [
      ...opts.baseline.map((sessionID) => ({ sessionID, role: EExperimentRole.Baseline })),
      ...opts.candidate.map((sessionID) => ({ sessionID, role: EExperimentRole.Candidate })),
    ],
  });
  return exp.id;
}

describe("evaluating an experiment", () => {
  it("reports improved discovery without claiming overall task quality", async () => {
    await withTempDir(async (dir) => {
      const h = makeHarness(dir);
      const id = await scenario(h, { baseline: ["b1", "b2", "b3"], candidate: ["c1", "c2", "c3"] });
      for (const s of ["c1", "c2", "c3"]) await h.read(s, STYLE, { delivered: wholeFile(2) });
      const result = await h.evaluation.evaluate(id);

      expect(result.verdict).toMatchObject({ verdict: EVerdict.Inconclusive, discovery: EVerdict.Improved, improved: ["discovery.explicit-read"], regressed: [] });
      expect(result.verdict.reasons.join(" ")).toContain("does not show that they performed better");
      expect(result.verdict.reasons.join(" ")).toContain("Task effectiveness remains unknown");
      const read = metric(result, "discovery.explicit-read");
      expect(read.baseline).toMatchObject({ n: 3, missing: 0, value: 0, numerator: 0, denominator: 3 });
      expect(read.candidate).toMatchObject({ n: 3, value: 1 });
      expect(read.absoluteChange).toBe(1);
      expect(read.relativeChange).toBeUndefined();
      expect(read.verdict).toBe(EVerdict.Improved);
      // Task success is a labeled metric and nothing was labeled: it stays unknown, not zero.
      expect(metric(result, "outcome.task-success")).toMatchObject({ baseline: { n: 0, missing: 3 }, verdict: EVerdict.Inconclusive });
      expect(result.limitations.join("\n")).toContain("No outcome labels");
    });
  });

  it("is inconclusive with too few sessions, and says so", async () => {
    await withTempDir(async (dir) => {
      const h = makeHarness(dir);
      const id = await scenario(h, { baseline: ["b1", "b2"], candidate: ["c1", "c2"] });
      for (const s of ["c1", "c2"]) await h.read(s, STYLE, { delivered: wholeFile(2) });
      const result = await h.evaluation.evaluate(id);
      expect(result.verdict.verdict).toBe(EVerdict.Inconclusive);
      expect(metric(result, "discovery.explicit-read").notes.join(" ")).toContain("Fewer than 3");
      expect(result.limitations.join("\n")).toContain("Sample sizes are small");
    });
  });

  it("reports a regression, and no change when the sides match", async () => {
    await withTempDir(async (dir) => {
      const h = makeHarness(dir);
      const id = await scenario(h, { baseline: ["b1", "b2", "b3"], candidate: ["c1", "c2", "c3"] });
      for (const s of ["b1", "b2", "b3"]) await h.read(s, STYLE, { delivered: wholeFile(2) });
      expect((await h.evaluation.evaluate(id)).verdict).toMatchObject({ verdict: EVerdict.Inconclusive, discovery: EVerdict.Regressed, regressed: ["discovery.explicit-read"] });
      for (const s of ["c1", "c2", "c3"]) await h.read(s, STYLE, { delivered: wholeFile(2) });
      expect((await h.evaluation.evaluate(id)).verdict.discovery).toBe(EVerdict.Unchanged);
    });
  });

  it("counts a lead and its subagents as one sample and keeps zero-read sessions in the denominator", async () => {
    await withTempDir(async (dir) => {
      const h = makeHarness(dir);
      const id = await scenario(h, { baseline: ["b1", "b2", "b3"], candidate: [] });
      // Candidate lead with two subagents, only one of which read the file (twice).
      await h.start("c1");
      await h.start("c1-sub1", "c1");
      await h.start("c1-sub2", "c1");
      await h.read("c1-sub1", STYLE, { delivered: wholeFile(2) });
      await h.read("c1-sub1", STYLE, { delivered: wholeFile(2) });
      await h.read("c1-sub2", STYLE, { delivered: wholeFile(2) });
      await h.experiments.setSessions(id, { add: [{ sessionID: "c1-sub2", role: EExperimentRole.Candidate }] });
      const result = await h.evaluation.evaluate(id);

      const c1 = result.groups.find((g) => g.sessionID === "c1")!;
      expect(result.groups.filter((g) => g.role === EExperimentRole.Candidate)).toHaveLength(1);
      expect([...c1.memberSessionIDs].sort()).toEqual(["c1", "c1-sub1", "c1-sub2"]);
      expect(c1).toMatchObject({ explicitTargetRead: true, repeatReads: 1, crossAgentRereads: 1, contextReads: 3 });
      expect(metric(result, "discovery.explicit-read").candidate).toMatchObject({ n: 1, numerator: 1, denominator: 1 });
      expect(metric(result, "discovery.explicit-read").baseline).toMatchObject({ n: 3, numerator: 0 });
    });
  });

  it("excludes sessions that are not clean samples, with the reason", async () => {
    await withTempDir(async (dir) => {
      const h = makeHarness(dir);
      await seedProject(h);
      await h.start("good");
      await h.start("mixed");
      await h.mark("historic");
      const exp = await h.create();
      await h.write(STYLE, "# Style\nUse spaces\n");
      await h.request("mixed");
      await h.experiments.confirmCandidate(exp.id, (await h.experiments.detectCandidate(exp.id)).revisionId);
      await h.start("cand");
      await h.write(".ai/architecture.md", "# Architecture\nunrelated\n");
      await h.start("confounded");
      await h.start("wrong-role");
      await h.experiments.setSessions(exp.id, {
        add: [
          { sessionID: "good", role: EExperimentRole.Baseline },
          { sessionID: "mixed", role: EExperimentRole.Baseline },
          { sessionID: "historic", role: EExperimentRole.Baseline },
          { sessionID: "cand", role: EExperimentRole.Candidate },
          { sessionID: "confounded", role: EExperimentRole.Candidate },
          { sessionID: "wrong-role", role: EExperimentRole.Baseline },
        ],
      });
      const result = await h.evaluation.evaluate(exp.id);
      const reason = (id: string) => result.exclusions.find((e) => e.sessionID === id)?.reason;
      expect(result.groups.map((g) => g.sessionID).sort()).toEqual(["cand", "good"]);
      expect(reason("mixed")).toBe(EExclusionReason.MixedRevision);
      expect(reason("historic")).toBe(EExclusionReason.UnknownRevision);
      expect(reason("confounded")).toBe(EExclusionReason.OtherContextDiffers);
      expect(reason("wrong-role")).toBe(EExclusionReason.OtherContextDiffers);
      expect(result.exclusions.find((e) => e.sessionID === "historic")?.detail).toContain("no revision recorded");
      expect(result.limitations.join("\n")).toContain("4 selected session(s) were excluded");
    });
  });

  it("excludes a session that ran under a revision the experiment does not know", async () => {
    await withTempDir(async (dir) => {
      const h = makeHarness(dir);
      await seedProject(h);
      const exp = await h.create();
      await h.write(STYLE, "# Style\nfirst edit\n");
      await h.start("other");
      await h.write(STYLE, "# Style\nsecond edit\n");
      await h.experiments.confirmCandidate(exp.id, (await h.experiments.detectCandidate(exp.id)).revisionId);
      await h.experiments.setSessions(exp.id, { add: [{ sessionID: "other", role: EExperimentRole.Candidate }] });
      expect((await h.evaluation.evaluate(exp.id)).exclusions[0]).toMatchObject({ reason: EExclusionReason.RevisionMismatch });
    });
  });

  it("evaluates before a candidate exists as a baseline-only view", async () => {
    await withTempDir(async (dir) => {
      const h = makeHarness(dir);
      await seedProject(h);
      await h.start("b1");
      const exp = await h.create({ baselineSessionIDs: ["b1"] });
      const result = await h.evaluation.evaluate(exp.id);
      expect(result.verdict.verdict).toBe(EVerdict.Inconclusive);
      expect(result.candidateRevisionId).toBeUndefined();
      expect(result.limitations.join("\n")).toContain("No candidate revision");
    });
  });

  it("is inconclusive when the models differ, and surfaces the context", async () => {
    await withTempDir(async (dir) => {
      const h = makeHarness(dir);
      await seedProject(h);
      for (const id of ["b1", "b2", "b3"]) await h.start(id, undefined, { model: "mock/small" });
      const exp = await h.create();
      await h.write(STYLE, "# Style\nnew\n");
      await h.experiments.confirmCandidate(exp.id, (await h.experiments.detectCandidate(exp.id)).revisionId);
      for (const id of ["c1", "c2", "c3"]) {
        await h.start(id, undefined, { model: "mock/large" });
        await h.read(id, STYLE, { delivered: wholeFile(2) });
      }
      await h.experiments.setSessions(exp.id, {
        add: [
          ...["b1", "b2", "b3"].map((sessionID) => ({ sessionID, role: EExperimentRole.Baseline })),
          ...["c1", "c2", "c3"].map((sessionID) => ({ sessionID, role: EExperimentRole.Candidate })),
        ],
      });
      const result = await h.evaluation.evaluate(exp.id);
      expect(result.context).toMatchObject({ baselineModels: ["mock/small"], candidateModels: ["mock/large"], modelsComparable: false });
      expect(result.verdict.verdict).toBe(EVerdict.Inconclusive);
      expect(result.verdict.reasons.join(" ")).toContain("models differ");
      expect(metric(result, "discovery.explicit-read").verdict).toBe(EVerdict.Inconclusive);
      expect(metric(result, "discovery.explicit-read").notes.join(" ")).toContain("Not comparable");
    });
  });

  it("is inconclusive when the tracking configuration differs between the sides", async () => {
    await withTempDir(async (dir) => {
      const h = makeHarness(dir);
      const id = await scenario(h, { baseline: ["b1", "b2", "b3"], candidate: [] });
      const { SessionRevisionTracker } = await import("../src/evaluation/session-revisions.js");
      const other = new SessionRevisionTracker(h.store, h.snapshotter, "env2", h.clock);
      for (const s of ["c1", "c2", "c3"]) {
        await h.mark(s);
        await other.observe({ sessionID: s, source: "context", priorTurns: false, model: "mock/scripted" });
        await h.read(s, STYLE, { delivered: wholeFile(2) });
      }
      await h.experiments.setSessions(id, { add: ["c1", "c2", "c3"].map((sessionID) => ({ sessionID, role: EExperimentRole.Candidate })) });
      const result = await h.evaluation.evaluate(id);
      expect(result.context.environmentsComparable).toBe(false);
      expect(result.verdict.verdict).toBe(EVerdict.Inconclusive);
    });
  });

  it("is inconclusive when other context files changed between the anchor revisions", async () => {
    await withTempDir(async (dir) => {
      const h = makeHarness(dir);
      const id = await scenario(h, {
        baseline: ["b1", "b2", "b3"],
        candidate: ["c1", "c2", "c3"],
        edit: async () => {
          await h.write(STYLE, "# Style\nnew\n");
          await h.write(".ai/architecture.md", "# Architecture\nalso changed\n");
        },
      });
      for (const s of ["c1", "c2", "c3"]) await h.read(s, STYLE, { delivered: wholeFile(2) });
      const result = await h.evaluation.evaluate(id);
      expect(result.context.nonTargetChanges).toEqual([".ai/architecture.md"]);
      expect(result.verdict.verdict).toBe(EVerdict.Inconclusive);
      expect(result.verdict.reasons.join(" ")).toContain(".ai/architecture.md");
    });
  });

  it("computes outcome rates only from grounded labels", async () => {
    await withTempDir(async (dir) => {
      const h = makeHarness(dir);
      const id = await scenario(h, { baseline: ["b1", "b2", "b3"], candidate: ["c1", "c2", "c3"] });
      for (const s of ["b1", "b2", "b3"]) await h.experiments.label(id, s, { taskSuccess: ETaskOutcome.Failure, note: "tests failed" });
      await h.experiments.label(id, "c1", { taskSuccess: ETaskOutcome.Success, evidenceRef: "PR #1" });
      await h.experiments.label(id, "c2", { taskSuccess: ETaskOutcome.Success, note: "merged" });
      await h.experiments.label(id, "c3", { taskSuccess: ETaskOutcome.Success, adherence: EAdherence.Followed });
      const result = await h.evaluation.evaluate(id);
      const success = metric(result, "outcome.task-success");
      // c3 has no note or evidence, so its label is not counted.
      expect(success.baseline).toMatchObject({ n: 3, value: 0 });
      expect(success.candidate).toMatchObject({ n: 2, missing: 1, value: 1 });
      expect(success.verdict).toBe(EVerdict.Inconclusive);
      expect(metric(result, "outcome.adherence").candidate.n).toBe(0);
      expect(result.groups.find((g) => g.sessionID === "c3")?.outcome?.taskSuccess).toBe(ETaskOutcome.Success);
    });
  });

  it("stores each evaluation with the experiment and reproduces it from the stored groups", async () => {
    await withTempDir(async (dir) => {
      const h = makeHarness(dir);
      const id = await scenario(h, { baseline: ["b1", "b2", "b3"], candidate: ["c1", "c2", "c3"] });
      for (const s of ["c1", "c2", "c3"]) await h.read(s, STYLE, { delivered: wholeFile(2) });
      const result = await h.evaluation.evaluate(id);
      const stored = (await h.experiments.get(id)).evaluations;
      expect(stored).toHaveLength(1);
      expect(stored[0]).toEqual(JSON.parse(JSON.stringify(result)));
      const again = compareGroups(
        result.groups.filter((g) => g.role === EExperimentRole.Baseline),
        result.groups.filter((g) => g.role === EExperimentRole.Candidate),
        result.context,
        result.settings,
      );
      expect(again).toEqual(result.metrics);
      expect(overallVerdict(again, result.context)).toEqual(result.verdict);
      await h.evaluation.evaluate(id);
      expect((await h.experiments.get(id)).evaluations).toHaveLength(2);
    });
  });

  it("does not store prompts, contents or commands", async () => {
    await withTempDir(async (dir) => {
      const h = makeHarness(dir);
      const id = await scenario(h, { baseline: ["b1"], candidate: [] });
      await h.evaluation.evaluate(id, [activity("b1", { verificationRuns: 1 })]);
      const { readFile } = await import("node:fs/promises");
      const text = await readFile(`${h.dataDir}/evaluation/experiments/${id}.json`, "utf8");
      expect(text).not.toContain("Use tabs");
      expect(text).not.toContain("Use spaces");
    });
  });
});

describe("measureGroup", () => {
  const read = (over: Partial<IContextReadRecord> = {}): IContextReadRecord => ({
    sessionID: "s",
    callID: "c",
    tool: "read",
    filePath: STYLE,
    matchedPattern: "x",
    requestedRange: {},
    status: EReadStatus.Completed,
    startedAt: "2026-01-01T00:00:10.000Z",
    completedAt: "2026-01-01T00:00:11.000Z",
    delivered: wholeFile(10),
    ...over,
  });
  const input = (records: IContextReadRecord[], extra: Partial<Parameters<typeof measureGroup>[0]> = {}) => ({
    sessionID: "s",
    role: EExperimentRole.Baseline,
    members: ["s"],
    records,
    targets: new Set([STYLE]),
    autoLoaded: ["AGENTS.md"],
    revisionState: ERevisionState.Stable,
    models: [],
    environments: [],
    ...extra,
  });

  it("measures a zero-read session as not having read, with the reason", () => {
    const g = measureGroup(input([]));
    expect(g).toMatchObject({ explicitTargetRead: false, contextReads: 0, readBeforeActionMissing: EMissing.NoRead, completenessMissing: EMissing.NoRead });
  });

  it("does not treat an auto-loaded target as unread", () => {
    const g = measureGroup(input([], { targets: new Set(["AGENTS.md"]) }));
    expect(g).toMatchObject({ explicitTargetRead: false, autoLoadedTargets: ["AGENTS.md"], readBeforeActionMissing: EMissing.AutoLoadedOnly });
    const metrics = compareGroups([g, g, g], [g, g, g], emptyContext());
    const explicit = metrics.find((m) => m.id === "discovery.explicit-read")!;
    expect(explicit.baseline).toMatchObject({ n: 0, missing: 3 });
    expect(explicit.verdict).toBe(EVerdict.Inconclusive);
  });

  it("orders the first target read against the first file change, when the timeline is complete", () => {
    expect(measureGroup(input([read()], { activity: activity("s", { actionCount: 1, firstActionAt: "2026-01-01T00:01:00.000Z" }) })).readBeforeAction).toBe(true);
    expect(measureGroup(input([read()], { activity: activity("s", { actionCount: 1, firstActionAt: "2026-01-01T00:00:05.000Z" }) })).readBeforeAction).toBe(false);
    expect(measureGroup(input([read()], { activity: activity("s") })).readBeforeActionMissing).toBe(EMissing.NoAction);
    expect(measureGroup(input([read()])).readBeforeActionMissing).toBe(EMissing.NoTimeline);
    // An incomplete message log may be missing the earliest action, so it proves no ordering.
    expect(
      measureGroup(input([read()], { activity: activity("s", { complete: false, unavailableSessions: 1, firstActionAt: "2026-01-01T00:01:00.000Z" }) })).readBeforeActionMissing,
    ).toBe(EMissing.NoTimeline);
  });

  it("separates full from partial reads, judged against the file as read", () => {
    expect(measureGroup(input([read()])).completeness).toBe(ECompleteness.Full);
    const partial = read({ requestedRange: { limit: 5 }, delivered: { source: EDeliverySource.Header, lineCount: 5, range: { start: 1, end: 5 }, reachedEof: false } });
    expect(measureGroup(input([partial])).completeness).toBe(ECompleteness.Partial);
    // Two reads that together cover the file make it full.
    const second = read({ callID: "c2", completedAt: "2026-01-01T00:00:12.000Z", requestedRange: { offset: 6 }, delivered: { source: EDeliverySource.Header, lineCount: 5, range: { start: 6, end: 10 }, reachedEof: true, fileLines: 10 } });
    expect(measureGroup(input([partial, second])).completeness).toBe(ECompleteness.Full);
    expect(fileCompleteness([read({ delivered: undefined })])).toBe(ECompleteness.Unknown);
    const unknown = measureGroup(input([read({ delivered: undefined })]));
    expect(unknown).toMatchObject({ completeness: ECompleteness.Unknown, completenessMissing: EMissing.NoDelivery });
  });

  it("counts repeats, cross-agent rereads and failed reads, and compares delivered with requested lines", () => {
    const records = [
      read({ callID: "1", sessionID: "s", requestedRange: { limit: 20 }, delivered: wholeFile(10) }),
      read({ callID: "2", sessionID: "s", completedAt: "2026-01-01T00:00:12.000Z" }),
      read({ callID: "1", sessionID: "sub", parentSessionID: "s", completedAt: "2026-01-01T00:00:13.000Z" }),
      read({ callID: "3", sessionID: "s", status: EReadStatus.Error, errorMessage: "nope", delivered: undefined, completedAt: "2026-01-01T00:00:14.000Z" }),
    ];
    const g = measureGroup(input(records, { members: ["s", "sub"] }));
    expect(g).toMatchObject({ repeatReads: 1, crossAgentRereads: 1, failedReads: 1, deliveredLines: 10, requestedLines: 20, contextReads: 4 });
  });

  it("ignores reads of other context files for target measures but counts them as activity", () => {
    const g = measureGroup(input([read({ filePath: "AGENTS.md" })]));
    expect(g).toMatchObject({ explicitTargetRead: false, contextReads: 1 });
  });
});

describe("compareGroups", () => {
  const group = (id: string, role: EExperimentRole, over: Partial<IGroupMeasurement> = {}): IGroupMeasurement => ({
    sessionID: id,
    role,
    memberSessionIDs: [id],
    revisionState: ERevisionState.Stable,
    explicitTargetRead: false,
    targetFilesRead: [],
    autoLoadedTargets: [],
    repeatReads: 0,
    crossAgentRereads: 0,
    failedReads: 0,
    deliveredLines: 0,
    requestedLines: 0,
    contextReads: 0,
    models: ["m"],
    environments: ["e"],
    ...over,
  });
  const many = (role: EExperimentRole, count: number, over: (i: number) => Partial<IGroupMeasurement>) =>
    Array.from({ length: count }, (_, i) => group(`${role}${i}`, role, over(i)));

  it("reports percentage-point change as an absolute fraction and relative change separately", () => {
    const b = many(EExperimentRole.Baseline, 4, (i) => ({ explicitTargetRead: i < 2, contextReads: 2 }));
    const c = many(EExperimentRole.Candidate, 4, (i) => ({ explicitTargetRead: i < 3, contextReads: 3 }));
    const metrics = compareGroups(b, c, emptyContext(sideContext(b, c)));
    const read = metrics.find((m) => m.id === "discovery.explicit-read")!;
    expect(read).toMatchObject({ baseline: { value: 0.5 }, candidate: { value: 0.75 }, absoluteChange: 0.25, relativeChange: 0.5, verdict: EVerdict.Improved });
    const reads = metrics.find((m) => m.id === "efficiency.context-reads")!;
    expect(reads).toMatchObject({ directional: false, absoluteChange: 1, relativeChange: 0.5 });
    expect(reads.verdict).toBeUndefined();
  });

  it("treats small differences as unchanged or inconclusive, never improved", () => {
    const base = (hits: number) => many(EExperimentRole.Baseline, 20, (i) => ({ explicitTargetRead: i < hits }));
    const cand = (hits: number) => many(EExperimentRole.Candidate, 20, (i) => ({ explicitTargetRead: i < hits }));
    const verdict = (b: number, c: number) =>
      compareGroups(base(b), cand(c), emptyContext(sideContext(base(b), cand(c)))).find((m) => m.id === "discovery.explicit-read")!.verdict;
    expect(verdict(10, 11)).toBe(EVerdict.Unchanged);
    expect(verdict(10, 13)).toBe(EVerdict.Inconclusive);
    expect(verdict(10, 14)).toBe(EVerdict.Improved);
    expect(verdict(14, 10)).toBe(EVerdict.Regressed);
  });

  it("reports mixed movement as inconclusive and names both lists", () => {
    const b = many(EExperimentRole.Baseline, 4, (i) => ({ explicitTargetRead: i < 1, completeness: ECompleteness.Full }));
    const c = many(EExperimentRole.Candidate, 4, (i) => ({ explicitTargetRead: i < 4, completeness: ECompleteness.Partial }));
    const ctx = emptyContext(sideContext(b, c));
    const verdict = overallVerdict(compareGroups(b, c, ctx), ctx);
    expect(verdict.verdict).toBe(EVerdict.Inconclusive);
    expect(verdict.improved).toContain("discovery.explicit-read");
    expect(verdict.regressed).toContain("discovery.complete-read");
  });

  it("computes verification evidence without deciding success", () => {
    const withRuns = (runs: number, withExit: number, nonZero: number) =>
      many(EExperimentRole.Baseline, 3, () => ({ activity: activity("x", { verificationRuns: runs, verificationWithExit: withExit, verificationNonZero: nonZero }) }));
    const b = withRuns(2, 1, 1);
    const c = many(EExperimentRole.Candidate, 3, () => ({ activity: activity("x", { complete: false, unavailableSessions: 1 }) }));
    const metrics = compareGroups(b, c, emptyContext());
    expect(metrics.find((m) => m.id === "verification.ran-verification")).toMatchObject({ baseline: { value: 1, n: 3 }, candidate: { n: 0, missing: 3 } });
    expect(metrics.find((m) => m.id === "verification.exit-code-known")?.baseline).toMatchObject({ numerator: 3, denominator: 6, value: 0.5 });
    expect(metrics.find((m) => m.id === "verification.nonzero-exit")?.baseline).toMatchObject({ numerator: 3, denominator: 3 });
    expect(metrics.filter((m) => m.group === "verification").every((m) => m.verdict === undefined && !m.directional)).toBe(true);
  });

  it("a missing activity summary is missing evidence, not a zero", () => {
    const b = many(EExperimentRole.Baseline, 3, () => ({}));
    const m = compareGroups(b, b, emptyContext()).find((x) => x.id === "verification.ran-verification")!;
    expect(m.baseline).toMatchObject({ n: 0, missing: 3 });
  });

  it("settings are explicit and recorded", () => {
    expect(DEFAULT_SETTINGS).toEqual({ minSamples: 3, rateThreshold: 0.2 });
    expect(isGrounded({ labeledAt: "t", taskSuccess: ETaskOutcome.Success })).toBe(false);
    expect(isGrounded({ labeledAt: "t", note: " " })).toBe(false);
    expect(isGrounded({ labeledAt: "t", evidenceRef: "PR" })).toBe(true);
  });
});

function emptyContext(over: Partial<IComparisonContext> = {}): IComparisonContext {
  return {
    baselineModels: [],
    candidateModels: [],
    baselineEnvironments: [],
    candidateEnvironments: [],
    nonTargetChanges: [],
    targetChanges: { added: [], removed: [], modified: [], renamed: [] },
    ...over,
  };
}
