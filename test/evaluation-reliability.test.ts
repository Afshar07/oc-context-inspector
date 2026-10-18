import { rm, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { compareGroups, overallVerdict, sideContext } from "../src/evaluation/comparison.js";
import {
  EAdherence,
  EExclusionReason,
  EExperimentRole,
  ERevisionState,
  ETaskOutcome,
  EVerdict,
  type IComparisonContext,
  type IEvaluationResult,
  type IGroupMeasurement,
} from "../src/evaluation/types.js";
import { evaluationLines, experimentLines, verdictSummary } from "../src/tui/evaluation-format.js";
import { makeHarness, seedProject, wholeFile, type Harness } from "./evaluation-helpers.js";
import { withTempDir } from "./helpers.js";

const STYLE = ".ai/style.md";
const metric = (result: { metrics: readonly { id: string }[] }, id: string) =>
  result.metrics.find((m) => m.id === id) as import("../src/evaluation/types.js").IMetricComparison;

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

const noChanges = { nonTargetChanges: [], targetChanges: { added: [], removed: [], modified: [], renamed: [] } };
const contextOf = (b: IGroupMeasurement[], c: IGroupMeasurement[], over: Partial<IComparisonContext> = {}): IComparisonContext => ({
  ...sideContext(b, c),
  ...noChanges,
  ...over,
});

// Candidate reads the target in every session, baseline in none: a clear discovery improvement.
const discoveryUp = (baseline: Partial<IGroupMeasurement> = {}, candidate: Partial<IGroupMeasurement> = {}) => ({
  b: many(EExperimentRole.Baseline, 4, () => ({ explicitTargetRead: false, ...baseline })),
  c: many(EExperimentRole.Candidate, 4, () => ({ explicitTargetRead: true, ...candidate })),
});

describe("comparability: unknown is not comparable", () => {
  const evaluate = (b: IGroupMeasurement[], c: IGroupMeasurement[]) => {
    const context = contextOf(b, c);
    const metrics = compareGroups(b, c, context);
    return { context, metrics, overall: overallVerdict(metrics, context), read: metrics.find((m) => m.id === "discovery.explicit-read")! };
  };

  it("allows directional verdicts when models and configurations are confirmed equal", () => {
    const { b, c } = discoveryUp();
    const { context, overall, read } = evaluate(b, c);
    expect(context).toMatchObject({ modelsComparable: true, environmentsComparable: true });
    expect(read.verdict).toBe(EVerdict.Improved);
    expect(overall.discovery).toBe(EVerdict.Improved);
  });

  it("withdraws verdicts for different models, and says they differ", () => {
    const { b, c } = discoveryUp({ models: ["small"] }, { models: ["large"] });
    const { context, overall, read } = evaluate(b, c);
    expect(context.modelsComparable).toBe(false);
    expect(read.verdict).toBe(EVerdict.Inconclusive);
    expect(read.notes.join(" ")).toContain("Not comparable: models differ");
    expect(overall).toMatchObject({ verdict: EVerdict.Inconclusive, discovery: EVerdict.Inconclusive, improved: [] });
    expect(overall.reasons.join(" ")).toContain("Not comparable: models differ");
  });

  it("withdraws verdicts for different configurations", () => {
    const { b, c } = discoveryUp({ environments: ["e1"] }, { environments: ["e2"] });
    const { context, overall, read } = evaluate(b, c);
    expect(context.environmentsComparable).toBe(false);
    expect(read.verdict).toBe(EVerdict.Inconclusive);
    expect(overall.discovery).toBe(EVerdict.Inconclusive);
  });

  it.each([
    ["baseline", { models: [] }, {}],
    ["candidate", {}, { models: [] }],
  ])("withdraws verdicts when the model is missing on the %s side, as unknown rather than different", (_side, bo, co) => {
    const { b, c } = discoveryUp(bo, co);
    const { context, overall, read } = evaluate(b, c);
    expect(context.modelsComparable).toBeUndefined();
    expect(read.verdict).toBe(EVerdict.Inconclusive);
    expect(read.notes.join(" ")).toContain("Comparability unknown");
    expect(read.notes.join(" ")).not.toContain("Not comparable");
    expect(overall).toMatchObject({ verdict: EVerdict.Inconclusive, discovery: EVerdict.Inconclusive });
    expect(overall.reasons.join(" ")).toContain("Comparability unknown");
    expect(overall.reasons.join(" ")).not.toContain("Not comparable");
  });

  it.each([
    ["baseline", { environments: [] }, {}],
    ["candidate", {}, { environments: [] }],
  ])("withdraws verdicts when the configuration is missing on the %s side", (_side, bo, co) => {
    const { b, c } = discoveryUp(bo, co);
    const { context, overall } = evaluate(b, c);
    expect(context.environmentsComparable).toBeUndefined();
    expect(overall.discovery).toBe(EVerdict.Inconclusive);
    expect(overall.reasons.join(" ")).toContain("plugin tracking configuration is not recorded");
  });

  it("treats one unknown session inside an otherwise known population as unknown", () => {
    const { b, c } = discoveryUp();
    b[1] = { ...b[1]!, models: [] };
    const { context, overall } = evaluate(b, c);
    expect(context.modelsComparable).toBeUndefined();
    expect(overall.discovery).toBe(EVerdict.Inconclusive);
  });

  it("keeps the descriptive measurements while the verdict is withdrawn", () => {
    const { b, c } = discoveryUp({ models: [] });
    const { read } = evaluate(b, c);
    expect(read).toMatchObject({ baseline: { n: 4, value: 0 }, candidate: { n: 4, value: 1 }, absoluteChange: 1, verdict: EVerdict.Inconclusive });
  });
});

describe("discovery is not effectiveness", () => {
  const overallOf = (b: IGroupMeasurement[], c: IGroupMeasurement[]) => {
    const context = contextOf(b, c);
    return overallVerdict(compareGroups(b, c, context), context);
  };
  const grounded = (taskSuccess: ETaskOutcome, adherence?: EAdherence) => ({
    outcome: { taskSuccess, ...(adherence !== undefined && { adherence }), note: "checked by hand", labeledAt: "t" },
  });

  it("reports a discovery improvement only, and states that effectiveness is unknown", () => {
    const { b, c } = discoveryUp();
    const overall = overallOf(b, c);
    expect(overall).toMatchObject({ verdict: EVerdict.Inconclusive, discovery: EVerdict.Improved, improved: ["discovery.explicit-read"] });
    expect(overall.reasons.join(" ")).toContain("does not show that they performed better");
    expect(overall.reasons.join(" ")).toContain("Task effectiveness remains unknown");
  });

  it("does not let better discovery rescue worse labeled outcomes, nor worse discovery hide better outcomes", () => {
    const b = many(EExperimentRole.Baseline, 4, () => grounded(ETaskOutcome.Failure));
    const c = many(EExperimentRole.Candidate, 4, () => ({ explicitTargetRead: true, ...grounded(ETaskOutcome.Success) }));
    expect(overallOf(b, c)).toMatchObject({ verdict: EVerdict.Improved, discovery: EVerdict.Improved });
    const worse = many(EExperimentRole.Candidate, 4, () => ({ explicitTargetRead: true, ...grounded(ETaskOutcome.Failure) }));
    const better = many(EExperimentRole.Baseline, 4, () => grounded(ETaskOutcome.Success));
    expect(overallOf(better, worse)).toMatchObject({ verdict: EVerdict.Regressed, discovery: EVerdict.Improved });
  });

  it("reports improved effectiveness without a discovery claim when only outcomes moved", () => {
    const b = many(EExperimentRole.Baseline, 4, () => ({ explicitTargetRead: true, ...grounded(ETaskOutcome.Failure) }));
    const c = many(EExperimentRole.Candidate, 4, () => ({ explicitTargetRead: true, ...grounded(ETaskOutcome.Success) }));
    expect(overallOf(b, c)).toMatchObject({ verdict: EVerdict.Improved, discovery: EVerdict.Unchanged });
  });

  it("calls opposing outcome movement inconclusive", () => {
    const b = many(EExperimentRole.Baseline, 4, () => grounded(ETaskOutcome.Failure, EAdherence.NotFollowed));
    const c = many(EExperimentRole.Candidate, 4, () => grounded(ETaskOutcome.Success, EAdherence.NotFollowed));
    const adherenceDown = c.map((g) => ({ ...g, outcome: { ...g.outcome!, adherence: EAdherence.NotFollowed } }));
    const base = b.map((g) => ({ ...g, outcome: { ...g.outcome!, adherence: EAdherence.Followed } }));
    expect(overallOf(base, adherenceDown)).toMatchObject({ verdict: EVerdict.Inconclusive });
  });

  it("ignores ungrounded labels for effectiveness", () => {
    const bare = { outcome: { taskSuccess: ETaskOutcome.Success, labeledAt: "t" } };
    const b = many(EExperimentRole.Baseline, 4, () => ({ outcome: { taskSuccess: ETaskOutcome.Failure, labeledAt: "t" } }));
    const c = many(EExperimentRole.Candidate, 4, () => bare);
    expect(overallOf(b, c).verdict).toBe(EVerdict.Inconclusive);
  });

  it("presents the two verdicts separately and never as a general improvement", () => {
    const { b, c } = discoveryUp();
    const context = contextOf(b, c);
    const metrics = compareGroups(b, c, context);
    const result = {
      baselineRevisionId: "aaaaaaaaaa",
      groups: [...b, ...c],
      exclusions: [],
      metrics,
      context,
      verdict: overallVerdict(metrics, context),
      limitations: [],
    } as unknown as IEvaluationResult;
    const view = evaluationLines(result, undefined).map((l) => l.text).join("\n");
    expect(view).toContain("Discovery: improved");
    expect(view).toContain("Task effectiveness: unknown (inconclusive)");
    expect(view).toContain("did agents read the files? not whether they did better");
    expect(verdictSummary(result.verdict)).toBe("discovery improved · task effectiveness unknown");
  });

  it("shows a result stored before the verdicts were separated as recorded, with a caution", () => {
    const { b, c } = discoveryUp();
    const context = contextOf(b, c);
    const legacy = {
      evaluatedAt: "2026-01-01T00:00:00.000Z",
      baselineRevisionId: "aaaaaaaaaa",
      groups: [],
      exclusions: [],
      metrics: compareGroups(b, c, context),
      context: { ...context },
      verdict: { verdict: EVerdict.Improved, improved: ["discovery.explicit-read"], regressed: [], reasons: [] },
      limitations: [],
    } as unknown as IEvaluationResult;
    const view = evaluationLines(legacy, undefined).map((l) => l.text).join("\n");
    expect(view).toContain("Verdict: improved (older evaluation; discovery and task effectiveness were not separated)");
    expect(verdictSummary(legacy.verdict)).toBe("improved");
    expect(experimentLines({ name: "n", status: "measuring", hypothesis: "h", targetFiles: [], criteria: {}, baseline: { revisionId: "x", capturedAt: "2026-01-01T00:00" }, sessions: [], evaluations: [legacy] } as never).map((l) => l.text).join("\n")).toContain(
      "Last evaluation",
    );
  });

  it("explains unknown comparability in the panel", () => {
    const { b, c } = discoveryUp({ models: [] });
    const context = contextOf(b, c, { missingAnchors: [EExperimentRole.Candidate] });
    const result = { baselineRevisionId: "a", groups: [], exclusions: [], metrics: [], context, verdict: overallVerdict([], context), limitations: [] } as unknown as IEvaluationResult;
    const view = evaluationLines(result, undefined).map((l) => l.text).join("\n");
    expect(view).toContain("models: unknown for at least one session");
    expect(view).toContain("candidate revision snapshot missing or damaged");
  });
});

/** Baseline sessions, a confirmed documentation change, candidate sessions that all read the target. */
async function scenario(h: Harness, opts: { candidateModel?: string | undefined } = {}) {
  await seedProject(h);
  const baseline = ["b1", "b2", "b3"];
  const candidate = ["c1", "c2", "c3"];
  for (const id of baseline) await h.start(id);
  const exp = await h.create();
  await h.write(STYLE, "# Style\nUse spaces\n");
  await h.experiments.confirmCandidate(exp.id, (await h.experiments.detectCandidate(exp.id)).revisionId);
  for (const id of candidate) {
    await h.mark(id);
    await h.tracker.observe({ sessionID: id, source: "context", priorTurns: false, ...(opts.candidateModel !== undefined && { model: opts.candidateModel }) });
    await h.read(id, STYLE, { delivered: wholeFile(2) });
  }
  await h.experiments.setSessions(exp.id, {
    add: [
      ...baseline.map((sessionID) => ({ sessionID, role: EExperimentRole.Baseline })),
      ...candidate.map((sessionID) => ({ sessionID, role: EExperimentRole.Candidate })),
    ],
  });
  return exp;
}

describe("anchor snapshots", () => {
  const snapshotFile = (h: Harness, revisionId: string) => path.join(h.dataDir, "evaluation", "snapshots", `${revisionId}.json`);

  it("compares normally when both snapshots are readable, without recording missing anchors", async () => {
    await withTempDir(async (dir) => {
      const h = makeHarness(dir);
      const exp = await scenario(h, { candidateModel: "mock/scripted" });
      const result = await h.evaluation.evaluate(exp.id);
      expect(result.context.missingAnchors).toBeUndefined();
      expect(result.verdict.discovery).toBe(EVerdict.Improved);
    });
  });

  it.each([
    ["missing", "baseline", (file: string) => rm(file)],
    ["corrupted", "baseline", (file: string) => writeFile(file, "{ not json")],
    ["missing", "candidate", (file: string) => rm(file)],
    ["corrupted", "candidate", (file: string) => writeFile(file, "[]")],
  ] as const)("is inconclusive when the %s %s snapshot cannot be read, and keeps the measurements", async (_kind, role, damage) => {
    await withTempDir(async (dir) => {
      const h = makeHarness(dir);
      const exp = await scenario(h, { candidateModel: "mock/scripted" });
      const full = await h.experiments.get(exp.id);
      await damage(snapshotFile(h, (role === "baseline" ? full.baseline : full.candidate!).revisionId));
      const result = await h.evaluation.evaluate(exp.id);

      expect(result.context.missingAnchors).toEqual([role]);
      expect(result.verdict).toMatchObject({ verdict: EVerdict.Inconclusive, discovery: EVerdict.Inconclusive, improved: [] });
      expect(result.verdict.reasons.join(" ")).toContain(`the ${role} revision snapshot is missing or damaged`);
      expect(metric(result, "discovery.explicit-read")).toMatchObject({ baseline: { n: 3, value: 0 }, candidate: { n: 3, value: 1 }, verdict: EVerdict.Inconclusive });
      expect(result.groups).toHaveLength(6);
      expect(result.limitations.join("\n")).toContain("snapshot is missing or damaged");
    });
  });

  it("keeps exclusions when a snapshot is missing", async () => {
    await withTempDir(async (dir) => {
      const h = makeHarness(dir);
      const exp = await scenario(h, { candidateModel: "mock/scripted" });
      await h.mark("historic");
      await h.experiments.setSessions(exp.id, { add: [{ sessionID: "historic", role: EExperimentRole.Baseline }] });
      await rm(snapshotFile(h, (await h.experiments.get(exp.id)).baseline.revisionId));
      const result = await h.evaluation.evaluate(exp.id);
      expect(result.exclusions).toEqual([expect.objectContaining({ sessionID: "historic", reason: EExclusionReason.UnknownRevision })]);
      expect(result.verdict.discovery).toBe(EVerdict.Inconclusive);
    });
  });
});

describe("metadata and evidence in a real evaluation", () => {
  it("is inconclusive, not improved, when the candidate sessions recorded no model", async () => {
    await withTempDir(async (dir) => {
      const h = makeHarness(dir);
      const exp = await scenario(h);
      const result = await h.evaluation.evaluate(exp.id);
      expect(result.context.modelsComparable).toBeUndefined();
      expect(result.verdict).toMatchObject({ verdict: EVerdict.Inconclusive, discovery: EVerdict.Inconclusive });
      expect(metric(result, "discovery.explicit-read")).toMatchObject({ candidate: { value: 1 }, verdict: EVerdict.Inconclusive });
      expect(result.limitations.join("\n")).toContain("Comparability unknown");
    });
  });

  it("excludes a session whose read records are unreadable instead of counting zero reads", async () => {
    await withTempDir(async (dir) => {
      const h = makeHarness(dir);
      const exp = await scenario(h, { candidateModel: "mock/scripted" });
      await writeFile(path.join(h.dataDir, "c3.jsonl"), "{ not json\n");
      const result = await h.evaluation.evaluate(exp.id);
      expect(result.exclusions).toEqual([expect.objectContaining({ sessionID: "c3", reason: EExclusionReason.RecordsUnreadable })]);
      expect(metric(result, "discovery.explicit-read").candidate).toMatchObject({ n: 2, value: 1 });
    });
  });

  it("keeps a session with no read file as a measured zero-read session", async () => {
    await withTempDir(async (dir) => {
      const h = makeHarness(dir);
      const exp = await scenario(h, { candidateModel: "mock/scripted" });
      const result = await h.evaluation.evaluate(exp.id);
      expect(result.exclusions).toEqual([]);
      expect(metric(result, "discovery.explicit-read").baseline).toMatchObject({ n: 3, numerator: 0, denominator: 3 });
    });
  });

  it("blocks a clean comparison when unrelated context changed, and when a subagent's revision is unknown", async () => {
    await withTempDir(async (dir) => {
      const h = makeHarness(dir);
      const exp = await scenario(h, { candidateModel: "mock/scripted" });
      // c4 spawned a subagent that was first seen mid-run: the group's start revision is unknown.
      await h.start("c4");
      await h.mark("c4-sub", "c4");
      await h.tracker.observe({ sessionID: "c4-sub", source: "context", priorTurns: true, model: "mock/scripted" });
      await h.experiments.setSessions(exp.id, { add: [{ sessionID: "c4", role: EExperimentRole.Candidate }] });
      const result = await h.evaluation.evaluate(exp.id);
      expect(result.exclusions).toEqual([expect.objectContaining({ sessionID: "c4", reason: EExclusionReason.UnknownRevision })]);
      expect(result.groups.filter((g) => g.role === EExperimentRole.Candidate)).toHaveLength(3);

      await h.write(".ai/architecture.md", "# Architecture\nchanged later\n");
      await h.start("c5");
      await h.experiments.setSessions(exp.id, { add: [{ sessionID: "c5", role: EExperimentRole.Candidate }] });
      const confounded = await h.evaluation.evaluate(exp.id);
      expect(confounded.exclusions.map((e) => e.reason)).toContain(EExclusionReason.OtherContextDiffers);
    });
  });
});
