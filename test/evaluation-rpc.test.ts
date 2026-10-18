import { describe, expect, it } from "vitest";
import { summarizeActivity } from "../src/evaluation/activity.js";
import { evaluationHandlers } from "../src/evaluation/rpc-handlers.js";
import { EExperimentRole } from "../src/evaluation/types.js";
import { ContextInspectorRpc } from "../src/rpc.js";
import { makeHarness, seedProject, wholeFile } from "./evaluation-helpers.js";
import { withTempDir } from "./helpers.js";

type Standard = { "~standard": { validate: (v: unknown) => unknown } };
const validate = async (schema: unknown, value: unknown) =>
  (await (schema as Standard)["~standard"].validate(value)) as { issues?: unknown[] };
const roundTrip = <T>(value: T): T => JSON.parse(JSON.stringify(value));

describe("evaluation RPC schemas", () => {
  it("accept what the services produce and reject malformed input", async () => {
    await withTempDir(async (dir) => {
      const h = makeHarness(dir);
      await seedProject(h);
      for (const id of ["b1", "b2", "b3"]) await h.start(id);
      const exp = await h.create({ baselineSessionIDs: ["b1", "b2", "b3"] });
      await h.write(".ai/style.md", "# Style\nnew\n");
      const candidate = await h.experiments.detectCandidate(exp.id);
      await h.experiments.confirmCandidate(exp.id, candidate.revisionId);
      for (const id of ["c1", "c2", "c3"]) {
        await h.start(id);
        await h.read(id, ".ai/style.md", { delivered: wholeFile(2) });
      }
      await h.experiments.setSessions(exp.id, { add: ["c1", "c2", "c3"].map((sessionID) => ({ sessionID, role: EExperimentRole.Candidate })) });
      await h.experiments.label(exp.id, "c1", { note: "ok", evidenceRef: "PR #1" });
      const activity = summarizeActivity("c1", [], 1);
      const result = await h.evaluation.evaluate(exp.id, [activity]);
      const handlers = evaluationHandlers({ experiments: h.experiments, evaluation: h.evaluation, groups: h.groups, snapshotter: h.snapshotter });
      const { methods } = ContextInspectorRpc;

      const experiment = await h.experiments.get(exp.id);
      expect((await validate(methods.listExperiments.output, roundTrip({ experiments: [experiment], unreadable: 0 }))).issues).toBeUndefined();
      expect((await validate(methods.createExperiment.output, roundTrip({ ok: true, experiment }))).issues).toBeUndefined();
      expect((await validate(methods.evaluateExperiment.output, roundTrip({ ok: true, result }))).issues).toBeUndefined();
      expect((await validate(methods.evaluateExperiment.output, { ok: false, error: "x" })).issues).toBeUndefined();
      expect((await validate(methods.evaluateExperiment.input, { id: exp.id, activity: [activity] })).issues).toBeUndefined();
      expect((await validate(methods.evaluateExperiment.input, { id: exp.id })).issues).toBeUndefined();
      expect((await validate(methods.experimentSessions.output, roundTrip(await handlers.experimentSessions({ id: exp.id })))).issues).toBeUndefined();
      expect((await validate(methods.detectCandidate.output, roundTrip(await handlers.detectCandidate({ id: exp.id })))).issues).toBeUndefined();
      expect((await validate(methods.sessionRevision.output, roundTrip(await handlers.sessionRevision({ sessionID: "c1" })))).issues).toBeUndefined();
      expect((await validate(methods.currentRevision.output, roundTrip(await handlers.currentRevision({})))).issues).toBeUndefined();

      expect((await validate(methods.createExperiment.input, { name: "n", hypothesis: "h", targetFiles: ["a"], origin: { kind: "manual" } })).issues).toBeUndefined();
      expect((await validate(methods.createExperiment.input, { name: "n", hypothesis: "h" })).issues).toBeDefined();
      expect((await validate(methods.createExperiment.input, { name: "n", hypothesis: "h", targetFiles: ["a"], origin: { kind: "other" } })).issues).toBeDefined();
      expect((await validate(methods.setExperimentSessions.input, { id: "x", add: [{ sessionID: "s", role: "bogus" }] })).issues).toBeDefined();
      expect((await validate(methods.labelSession.input, { id: "x", sessionID: "s", taskSuccess: "maybe" })).issues).toBeDefined();
      expect((await validate(methods.labelSession.input, { id: "x", sessionID: "s", taskSuccess: "success", note: "n" })).issues).toBeUndefined();
      expect((await validate(methods.confirmCandidate.input, { id: "x" })).issues).toBeDefined();
    });
  });

  it("keeps the existing methods and events unchanged", async () => {
    const { methods, events } = ContextInspectorRpc;
    expect(Object.keys(methods)).toEqual(expect.arrayContaining(["coverage", "analyzeSession", "reviewProject", "preview"]));
    expect(Object.keys(events)).toEqual(["read"]);
    expect((await validate(methods.analyzeSession.input, { sessionID: "s", task: [] })).issues).toBeUndefined();
  });
});

describe("summarizeActivity", () => {
  const assistant = (parts: unknown[], created = 1000) => ({ type: "assistant", time: { created }, content: parts });
  const tool = (name: string, extra: Record<string, unknown> = {}, created?: number) => ({
    type: "tool",
    name,
    ...(created !== undefined && { time: { created } }),
    state: { status: "completed", ...extra },
  });

  it("finds the first file-changing call and counts shell and test-like runs, never returning command text", () => {
    const activity = summarizeActivity(
      "s",
      [
        {
          messages: [
            assistant([tool("read"), tool("edit", {}, 5000), tool("write", {}, 3000)]),
            assistant([
              tool("bash", { input: { command: "npm test -- --run" }, metadata: { exit: 1 } }),
              tool("bash", { input: { command: "ls -la" }, metadata: { exit: 0 } }),
              tool("bash", { input: { command: "tsc --noEmit" } }),
            ]),
            { type: "shell", command: "npm run build", status: "exited", exit: 0 },
            { type: "shell", command: "vitest", status: "running" },
          ],
        },
      ],
      0,
    );
    expect(activity).toMatchObject({
      complete: true,
      actionCount: 2,
      firstActionAt: new Date(3000).toISOString(),
      shellRuns: 5,
      shellWithExit: 3,
      shellNonZero: 1,
      verificationRuns: 4,
      verificationWithExit: 2,
      verificationNonZero: 1,
    });
    expect(JSON.stringify(activity)).not.toMatch(/npm|vitest|tsc|ls -la/);
  });

  it("marks an incomplete log, skips unknown shapes, and leaves out firstActionAt when there is no action", () => {
    const activity = summarizeActivity("s", [{ messages: [null, 7, { type: "assistant", content: "nope" }, { type: "mystery" }] }], 2);
    expect(activity).toMatchObject({ complete: false, unavailableSessions: 2, actionCount: 0, shellRuns: 0 });
    expect(activity.firstActionAt).toBeUndefined();
  });

  it("does not count a command as verification just because it ran", () => {
    expect(summarizeActivity("s", [{ messages: [{ type: "shell", command: "git status", status: "exited", exit: 0 }] }], 0)).toMatchObject({
      shellRuns: 1,
      verificationRuns: 0,
    });
  });
});
