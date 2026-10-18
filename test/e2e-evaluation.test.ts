// Revision and experiment checks on data a real OpenCode run produced (waves 1-3 of e2e/run.sh). Skipped unless
// run.sh sets the E2E_* variables. The documentation change was made by a scripted session (G), so this test
// recreates the pre-change files from the copy run.sh took, to prove that revisions are content-addressed.
import { readFile, readdir, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
  EExclusionReason,
  EExperimentRole,
  ERevisionState,
  ESessionFit,
  EVerdict,
} from "../src/evaluation/types.js";
import { makeHarness } from "./evaluation-helpers.js";

const projectDir = process.env.E2E_PROJECT_DIR;
const before = process.env.E2E_STYLE_BEFORE;
const after = process.env.E2E_STYLE_AFTER;

describe.skipIf(!projectDir || !before || !after)("revisions and experiments from a real OpenCode run", () => {
  const dir = projectDir ?? "";
  const style = path.join(dir, ".ai/style.md");

  it("classifies every session by the revision it ran under, then compares them", async () => {
    const h = makeHarness(dir);
    const beforeText = await readFile(before!, "utf8");
    const afterText = await readFile(after!, "utf8");
    const readLogs = async () =>
      Promise.all((await readdir(h.dataDir)).filter((n) => n.endsWith(".jsonl")).sort().map(async (n) => [n, await readFile(path.join(h.dataDir, n), "utf8")]));
    const logsBefore = await readLogs();

    // --- Phase 1: what the hooks recorded ---
    const leads = await h.groups.leads();
    expect(leads).toHaveLength(10); // A-F, G, H, I, J; the subagents S, N, K are grouped under their leads
    const revisions = await Promise.all(leads.map((id) => h.groups.revision(id)));
    const stable = revisions.filter((r) => r.state === ERevisionState.Stable);
    const mixed = revisions.filter((r) => r.state === ERevisionState.Mixed);
    expect(revisions.filter((r) => r.state === ERevisionState.Unknown)).toEqual([]);
    expect(mixed).toHaveLength(1);

    const oldRevision = stable.filter((r) => r.startRevisionId === mixed[0]!.startRevisionId);
    const newRevision = stable.filter((r) => r.startRevisionId !== mixed[0]!.startRevisionId);
    expect(oldRevision).toHaveLength(6); // A-F ran before the change, concurrently, on identical files
    expect(newRevision).toHaveLength(3); // H, I, J ran after it
    expect(new Set(newRevision.map((r) => r.startRevisionId)).size).toBe(1);
    // G changed the documentation itself: it started on the old revision and saw the new one.
    expect(mixed[0]!.revisionIds).toEqual([oldRevision[0]!.startRevisionId, newRevision[0]!.startRevisionId]);

    // A lead is stable only if its subagents saw the same revision (J's subagent K read the new style guide).
    expect(newRevision.some((r) => r.members.length === 2)).toBe(true);
    expect(oldRevision.filter((r) => r.members.length === 2)).toHaveLength(2); // E+S, F+N

    // --- Phase 2: an experiment whose baseline is the old revision ---
    await writeFile(style, beforeText);
    const restored = await h.snapshotter.current();
    expect(restored.id).toBe(oldRevision[0]!.startRevisionId); // same bytes, same id, across processes

    const exp = await h.create({ name: "Style guide wording", hypothesis: "Agents read .ai/style.md more often after the rewrite", targetFiles: [".ai/style.md"] });
    expect(exp.baseline.revisionId).toBe(restored.id);

    await writeFile(style, afterText);
    const detection = await h.experiments.detectCandidate(exp.id);
    expect(detection).toMatchObject({ changed: true, targetChanges: { modified: [".ai/style.md"] }, otherChanges: [] });
    expect(detection.revisionId).toBe(newRevision[0]!.startRevisionId);
    await h.experiments.confirmCandidate(exp.id, detection.revisionId);

    const offers = Object.fromEntries((await h.experiments.offers(exp.id)).map((o) => [o.sessionID, o.fit]));
    expect(Object.values(offers).filter((f) => f === ESessionFit.Baseline)).toHaveLength(6);
    expect(Object.values(offers).filter((f) => f === ESessionFit.Candidate)).toHaveLength(3);
    expect(offers[mixed[0]!.sessionID]).toBe(ESessionFit.Mixed);

    // The user picks the suggestions, and also the mixed session by mistake.
    await h.experiments.setSessions(exp.id, {
      add: [
        ...oldRevision.map((r) => ({ sessionID: r.leadSessionID, role: EExperimentRole.Baseline })),
        ...newRevision.map((r) => ({ sessionID: r.leadSessionID, role: EExperimentRole.Candidate })),
        { sessionID: mixed[0]!.leadSessionID, role: EExperimentRole.Candidate },
      ],
    });
    const result = await h.evaluation.evaluate(exp.id);

    expect(result.exclusions).toEqual([expect.objectContaining({ sessionID: mixed[0]!.leadSessionID, reason: EExclusionReason.MixedRevision })]);
    expect(result.groups.filter((g) => g.role === EExperimentRole.Baseline)).toHaveLength(6);
    expect(result.groups.filter((g) => g.role === EExperimentRole.Candidate)).toHaveLength(3);
    expect(result.context).toMatchObject({ baselineModels: ["mock/scripted"], candidateModels: ["mock/scripted"], modelsComparable: true, environmentsComparable: true });

    const metric = (id: string) => result.metrics.find((m) => m.id === id)!;
    // Baseline: B and E read the style guide (E through its own read, not its subagent's). Candidate: H, and J through its subagent.
    expect(metric("discovery.explicit-read")).toMatchObject({
      baseline: { n: 6, numerator: 2, denominator: 6 },
      candidate: { n: 3, numerator: 2, denominator: 3 },
      verdict: EVerdict.Improved,
    });
    // Only two sessions per side read it, below the minimum: no verdict is claimed.
    expect(metric("discovery.complete-read")).toMatchObject({ baseline: { n: 2, value: 0 }, candidate: { n: 2, value: 1 }, verdict: EVerdict.Inconclusive });
    // No message log outside the TUI: ordering and verification evidence are reported as missing, not zero.
    expect(metric("discovery.read-before-action").baseline.missing).toBe(6);
    expect(metric("verification.ran-verification").baseline).toMatchObject({ n: 0, missing: 6 });
    expect(metric("outcome.task-success").candidate.n).toBe(0);
    expect(result.verdict).toMatchObject({ verdict: EVerdict.Improved, improved: ["discovery.explicit-read"], regressed: [] });

    // --- Compatibility and privacy ---
    expect(await readLogs()).toEqual(logsBefore); // evaluating does not touch the read logs
    const stored = await readFile(path.join(h.dataDir, "evaluation", "experiments", `${exp.id}.json`), "utf8");
    for (const secret of ["Use spaces", "Keep functions short", "style line 3"]) expect(stored).not.toContain(secret);
    expect((await h.experiments.get(exp.id)).evaluations).toHaveLength(1);
  });
});
