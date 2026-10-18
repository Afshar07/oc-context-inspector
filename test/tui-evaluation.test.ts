import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { EExperimentRole, EExperimentStatus, ESessionFit, EVerdict, type IExperiment, type ISessionOffer } from "../src/evaluation/types.js";
import type { ICandidateDetection } from "../src/evaluation/experiments.js";
import { evaluationLines, experimentLines, experimentOption, formatChange, formatSide, offerOption, percent } from "../src/tui/evaluation-format.js";
import type { IExperimentClient, Reply } from "../src/tui/experiment-client.js";
import { experimentFlows, pickMany } from "../src/tui/experiment-flow.js";
import type { IFileCoverage } from "../src/types.js";
import { summarize } from "../src/coverage.js";
import { makeHarness, seedProject, wholeFile } from "./evaluation-helpers.js";
import { withTempDir } from "./helpers.js";

const text = (lines: readonly { text: string }[]) => lines.map((l) => l.text).join("\n");

describe("evaluation formatting", () => {
  const rate = (b: number, c: number) =>
    ({
      id: "m", label: "L", group: "discovery", kind: "observed", unit: "rate", directional: true,
      baseline: { n: 4, missing: 0, value: b, numerator: b * 4, denominator: 4 },
      candidate: { n: 4, missing: 0, value: c, numerator: c * 4, denominator: 4 },
      ...(b !== c && { absoluteChange: c - b }),
      ...(b !== 0 && b !== c && { relativeChange: (c - b) / b }),
      notes: [],
    }) as never;

  it("shows rates in percentage points and the relative change separately", () => {
    expect(formatChange(rate(0.5, 0.75))).toBe("+25 pp (+50% rel.)");
    expect(formatChange(rate(0.75, 0.5))).toBe("−25 pp (−33% rel.)");
    expect(formatChange(rate(0, 1))).toBe("+100 pp");
    expect(formatSide(rate(0.5, 0.75), (rate(0.5, 0.75) as { baseline: never }).baseline)).toBe("50% (2/4)");
    expect(percent(0.666)).toBe("67%");
  });

  it("shows means in units and missing sides as a dash", () => {
    const mean = { unit: "mean", absoluteChange: 1, relativeChange: 0.5, baseline: { n: 0, missing: 2 }, candidate: { n: 2, missing: 0, value: 3 } } as never;
    expect(formatChange(mean)).toBe("+1.0 (+50% rel.)");
    expect(formatSide(mean, (mean as { baseline: never }).baseline)).toBe("—");
    expect(formatSide(mean, (mean as { candidate: never }).candidate)).toBe("3.0 (n=2)");
    expect(formatChange({ unit: "rate" } as never)).toBe("—");
  });
});

describe("evaluation view", () => {
  it("separates observed from human-labeled, names the metric behind an improvement and lists exclusions and limits", async () => {
    await withTempDir(async (dir) => {
      const h = makeHarness(dir);
      await seedProject(h);
      for (const id of ["b1", "b2", "b3"]) await h.start(id);
      await h.mark("old");
      const exp = await h.create({ baselineSessionIDs: ["b1", "b2", "b3", "old"] });
      await h.write(".ai/style.md", "# Style\nnew\n");
      await h.experiments.confirmCandidate(exp.id, (await h.experiments.detectCandidate(exp.id)).revisionId);
      for (const id of ["c1", "c2", "c3"]) {
        await h.start(id);
        await h.read(id, ".ai/style.md", { delivered: wholeFile(2) });
      }
      await h.experiments.setSessions(exp.id, { add: ["c1", "c2", "c3"].map((sessionID) => ({ sessionID, role: EExperimentRole.Candidate })) });
      const result = await h.evaluation.evaluate(exp.id);
      const view = text(evaluationLines(result, await h.experiments.get(exp.id)));

      expect(view).toContain("Verdict: improved — Sessions that read a target file");
      expect(view).not.toMatch(/task quality improved|overall improvement/i);
      expect(view.indexOf("Observed (counted")).toBeLessThan(view.indexOf("Human-labeled (typed by you"));
      expect(view).toContain("+100 pp");
      expect(view).toContain("Excluded sessions");
      expect(view).toContain("old (baseline): unknown revision");
      expect(view).toContain("no evidence for:");
      expect(view).toContain("What this cannot show");
      expect(view).toContain("target change ~ .ai/style.md");
      expect(view).toContain("models: baseline mock/scripted · candidate mock/scripted");
    });
  });

  it("explains an inconclusive verdict that has movement in both directions", () => {
    const metric = (id: string, verdict: EVerdict) => ({ id, label: id, group: "discovery", kind: "observed", unit: "rate", directional: true, baseline: { n: 3, missing: 0 }, candidate: { n: 3, missing: 0 }, verdict, notes: [] });
    const result = {
      baselineRevisionId: "aaaaaaaaaa",
      groups: [],
      exclusions: [],
      metrics: [metric("up", EVerdict.Improved), metric("down", EVerdict.Regressed)],
      context: { baselineModels: [], candidateModels: [], baselineEnvironments: [], candidateEnvironments: [], nonTargetChanges: [], targetChanges: { added: [], removed: [], modified: [], renamed: [] } },
      verdict: { verdict: EVerdict.Inconclusive, improved: ["up"], regressed: ["down"], reasons: ["Some metrics improved while others regressed."] },
      limitations: ["x"],
    } as never;
    const view = text(evaluationLines(result, undefined));
    expect(view).toContain("Verdict: inconclusive");
    expect(view).toContain("improved: up");
    expect(view).toContain("regressed: down");
  });

  it("describes experiments and offers for the pickers", () => {
    const experiment = { id: "e", name: "N", hypothesis: "H", status: EExperimentStatus.AwaitingCandidate, baseline: { revisionId: "1234567890abcdef" }, sessions: [{}] } as never;
    expect(experimentOption(experiment)).toMatchObject({ title: "N", value: "e", footer: "12345678 → — · 1 sessions" });
    const offer: ISessionOffer = { sessionID: "s", revisionState: "stable" as never, fit: ESessionFit.OtherContextDiffers, descendants: 2, selectedRole: EExperimentRole.Baseline };
    expect(offerOption(offer, "Fix bug", false).description).toBe("target files match, other context differs · +2 sub · baseline");
    expect(offerOption(offer, undefined, true)).toMatchObject({ title: "s", description: "target files match, other context differs · +2 sub" });
  });
});

// A scripted stand-in for the TUI context: dialogs answer from a queue and every question is kept.
function fakeCtx(answers: unknown[]) {
  const asked: { kind: string; options: any }[] = [];
  const toasts: { variant: string; message: string }[] = [];
  const next = (kind: string) => async (options: any) => {
    asked.push({ kind, options });
    return answers.shift();
  };
  const ctx = {
    ui: {
      dialog: { select: next("select"), prompt: next("prompt"), confirm: next("confirm"), alert: next("alert") },
      toast: { show: (t: { variant: string; message: string }) => void toasts.push(t) },
    },
    data: { session: { get: (id: string) => (id === "named" ? { title: "Named session" } : undefined) } },
  };
  return { ctx: ctx as never, asked, toasts, remaining: () => answers.length };
}

const ok = <T>(value: T): Reply<T> => ({ ok: true, value });
const experiment = (over: Partial<IExperiment> = {}): IExperiment => ({
  version: 1,
  id: "exp_1",
  name: "Routing",
  hypothesis: "H",
  targetFiles: ["a.md"],
  criteria: {},
  status: EExperimentStatus.AwaitingCandidate,
  createdAt: "t",
  updatedAt: "t",
  baseline: { revisionId: "base0000", targetRevisionId: "tb", capturedAt: "2026-01-01T00:00:00.000Z" },
  sessions: [],
  evaluations: [],
  history: [],
  ...over,
});

function fakeClient(over: Partial<IExperimentClient> = {}): IExperimentClient & { calls: Record<string, unknown[][]> } {
  const calls: Record<string, unknown[][]> = {};
  const spy = <K extends keyof IExperimentClient>(name: K, impl: IExperimentClient[K]) =>
    ((...args: unknown[]) => ((calls[name] ??= []).push(args), (impl as (...a: unknown[]) => unknown)(...args))) as IExperimentClient[K];
  return {
    calls,
    list: spy("list", async () => ({ experiments: [experiment()], unreadable: 0 })),
    create: spy("create", async () => ok(experiment())),
    close: spy("close", async () => ok(experiment({ status: EExperimentStatus.Closed }))),
    detectCandidate: spy("detectCandidate", async () => ok({ changed: false, revisionId: "r", targetRevisionId: "t", targetChanges: { added: [], removed: [], modified: [], renamed: [] }, otherChanges: [], alreadyConfirmed: false } as ICandidateDetection)),
    confirmCandidate: spy("confirmCandidate", async () => ok(experiment())),
    offers: spy("offers", async () => ok([] as readonly ISessionOffer[])),
    setSessions: spy("setSessions", async () => ok(experiment())),
    label: spy("label", async () => ok(experiment())),
    evaluate: spy("evaluate", async () => ({ ok: false, error: "unused" })),
    revision: spy("revision", async () => ({}) as never),
    ...over,
  };
}

const file = (filePath: string, readLines: number): IFileCoverage =>
  summarize(
    filePath,
    readLines === 0
      ? []
      : [{ sessionID: "s", callID: "c", tool: "read", filePath, matchedPattern: "x", requestedRange: {}, status: "completed" as never, startedAt: "t", completedAt: "t", delivered: wholeFile(readLines) }],
    { exists: true, lineCount: 10 },
    false,
  );

describe("pickMany", () => {
  it("toggles options until done, keeps option order, and cancels cleanly", async () => {
    const { ctx, asked } = fakeCtx(["b", "a", "b", "\u0000done"]);
    const options = ["a", "b", "c"].map((v) => ({ title: v, value: v }));
    expect(await pickMany(ctx, { title: "T", options, initial: new Set(["c"]) })).toEqual(["a", "c"]);
    expect(asked[0]!.options.title).toBe("T (1 selected)");
    expect(asked[3]!.options.options.map((o: { title: string }) => o.title)).toEqual(["▶ Done: keep 2 selected", "✓ a", "○ b", "✓ c"]);
    expect(await pickMany(fakeCtx([undefined]).ctx, { title: "T", options, initial: new Set(["a"]) })).toBeUndefined();
  });
});

describe("create from an analysis", () => {
  it("asks for name, hypothesis, files and category, preselects files that were not fully read, and creates", async () => {
    const files = [file("a.md", 0), file("b.md", 10), file("c.md", 0)];
    const { ctx, asked, toasts } = fakeCtx(["Name ", "Hyp", "\u0000done", "  api work "]);
    const client = fakeClient();
    await experimentFlows(ctx, client, { coverageFiles: async () => files, openEvaluation: vi.fn() }).createFromAnalysis("s", { kind: "session-analysis", sessionID: "s" }, files);

    const picker = asked.find((q) => q.kind === "select")!.options;
    expect(picker.title).toBe("Context files this experiment is about (2 selected)");
    expect(client.calls.create).toEqual([["s", { name: "Name ", hypothesis: "Hyp", targetFiles: ["a.md", "c.md"], taskCategory: "  api work ", origin: { kind: "session-analysis", sessionID: "s" } }]]);
    expect(toasts[0]!.message).toContain("Edit the docs yourself");
    expect(client.calls.setSessions).toBeUndefined();
  });

  it("creates nothing when the user backs out at any step, or when the server refuses", async () => {
    const files = [file("a.md", 0)];
    for (const answers of [[undefined], ["n", undefined], ["n", "h", undefined], ["n", "h", "\u0000done", undefined]]) {
      const client = fakeClient();
      await experimentFlows(fakeCtx(answers).ctx, client, { coverageFiles: async () => files, openEvaluation: vi.fn() }).createFromAnalysis("s", { kind: "manual" }, files);
      expect(client.calls.create).toBeUndefined();
    }
    const { ctx, toasts } = fakeCtx(["n", "h", "\u0000done", ""]);
    const client = fakeClient({ create: async () => ({ ok: false, error: "An open experiment is already named x." }) });
    await experimentFlows(ctx, client, { coverageFiles: async () => files, openEvaluation: vi.fn() }).createFromAnalysis("s", { kind: "manual" }, files);
    expect(toasts).toEqual([{ variant: "error", message: "An open experiment is already named x." }]);
  });

  it("does not offer an experiment when there are no context files", async () => {
    const { ctx, toasts } = fakeCtx([]);
    await experimentFlows(ctx, fakeClient(), { coverageFiles: async () => [], openEvaluation: vi.fn() }).createFromAnalysis("s", { kind: "manual" }, []);
    expect(toasts[0]!.message).toBe("No context files to test");
  });
});

describe("managing experiments", () => {
  const flows = (answers: unknown[], client: IExperimentClient, openEvaluation = vi.fn()) => {
    const fake = fakeCtx(answers);
    return { ...fake, run: () => experimentFlows(fake.ctx, client, { coverageFiles: async () => [file("a.md", 0)], openEvaluation }).manage("s"), openEvaluation };
  };

  it("lists experiments, inspects one and leaves on cancel", async () => {
    const { asked, run, remaining } = flows(["exp_1", "inspect", undefined, undefined], fakeClient());
    await run();
    expect(asked[0]!.options.options.map((o: { value: string }) => o.value)).toEqual(["\u0000new", "exp_1"]);
    expect(asked[2]!.kind).toBe("alert");
    expect(asked[2]!.options.message).toContain("Hypothesis: H");
    expect(remaining()).toBe(0);
  });

  it("opens the evaluation and leaves the menu", async () => {
    const { run, openEvaluation } = flows(["exp_1", "evaluate"], fakeClient());
    await run();
    expect(openEvaluation).toHaveBeenCalledWith("exp_1");
  });

  it("tells the user nothing changed when the target files match the baseline", async () => {
    const { asked, run } = flows(["exp_1", "candidate", undefined, undefined], fakeClient());
    await run();
    expect(asked.find((q) => q.kind === "alert")!.options.title).toBe("No change to the target files");
  });

  it("confirms a detected candidate only when the user agrees, warning about other changes", async () => {
    const detection: ICandidateDetection = { changed: true, revisionId: "cand1234abcd", targetRevisionId: "t", targetChanges: { added: [], removed: [], modified: ["a.md"], renamed: [] }, otherChanges: ["b.md"], alreadyConfirmed: false };
    const declined = fakeClient({ detectCandidate: async () => ok(detection) });
    const first = flows(["exp_1", "candidate", false, undefined, undefined], declined);
    await first.run();
    expect(first.asked.find((q) => q.kind === "confirm")!.options.message).toContain("~ a.md");
    expect(first.asked.find((q) => q.kind === "confirm")!.options.message).toContain("verdict will be inconclusive");
    expect(declined.calls.confirmCandidate).toBeUndefined();

    const accepted = fakeClient({ detectCandidate: async () => ok(detection) });
    const second = flows(["exp_1", "candidate", true, undefined, undefined], accepted);
    await second.run();
    expect(accepted.calls.confirmCandidate).toEqual([["s", "exp_1", "cand1234abcd"]]);
  });

  it("selects sessions: lists matching revisions first, adds and removes, and warns about mismatches", async () => {
    const offers: ISessionOffer[] = [
      { sessionID: "other", revisionState: "unknown" as never, fit: ESessionFit.Unknown, descendants: 0 },
      { sessionID: "named", revisionState: "stable" as never, fit: ESessionFit.Baseline, descendants: 1 },
      { sessionID: "kept", revisionState: "stable" as never, fit: ESessionFit.Baseline, descendants: 0, selectedRole: EExperimentRole.Baseline },
    ];
    const selected = experiment({ sessions: [{ sessionID: "kept", role: EExperimentRole.Baseline, addedAt: "t" }] });
    const client = fakeClient({ list: async () => ({ experiments: [selected], unreadable: 0 }), offers: async () => ok(offers) });
    // Add "named" and the mismatching "other", drop "kept", then accept the warning.
    const { asked, run } = flows(["exp_1", "baseline", "named", "other", "kept", "\u0000done", true, undefined, undefined], client);
    await run();
    const picker = asked.find((q) => q.options.title?.startsWith("Baseline sessions"))!.options.options;
    expect(picker.slice(1).map((o: { value: string }) => o.value)).toEqual(["named", "kept", "other"]);
    expect(picker[1].title).toBe("○ Named session");
    expect(asked.find((q) => q.kind === "confirm")!.options.message).toContain("revision unknown");
    expect(client.calls.setSessions).toEqual([["s", "exp_1", { add: [{ sessionID: "named", role: "baseline" }, { sessionID: "other", role: "baseline" }], remove: ["kept"] }]]);
  });

  it("labels a session only with what the user typed", async () => {
    const selected = experiment({ sessions: [{ sessionID: "named", role: EExperimentRole.Baseline, addedAt: "t" }] });
    const client = fakeClient({ list: async () => ({ experiments: [selected], unreadable: 0 }) });
    const { run } = flows(["exp_1", "label", "named", "success", "followed", "CI green", "PR #1", undefined, undefined], client);
    await run();
    expect(client.calls.label).toEqual([["s", "exp_1", "named", { taskSuccess: "success", adherence: "followed", note: "CI green", evidenceRef: "PR #1" }]]);
  });

  it("closes only after confirmation, and a closed experiment offers no editing", async () => {
    const client = fakeClient();
    const closing = flows(["exp_1", "close", true, "done", undefined, undefined], client);
    await closing.run();
    expect(client.calls.close).toEqual([["s", "exp_1", "done"]]);

    const closed = fakeClient({ list: async () => ({ experiments: [experiment({ status: EExperimentStatus.Closed })], unreadable: 0 }) });
    const menu = flows(["exp_1", undefined, undefined], closed);
    await menu.run();
    expect(menu.asked[1]!.options.options.map((o: { value: string }) => o.value)).toEqual(["inspect", "evaluate"]);
  });

  it("shows how to create one when there are none, for evaluation", async () => {
    const { ctx, toasts } = fakeCtx([]);
    const client = fakeClient({ list: async () => ({ experiments: [], unreadable: 0 }) });
    expect(await experimentFlows(ctx, client, { coverageFiles: async () => [], openEvaluation: vi.fn() }).chooseForEvaluation("s")).toBeUndefined();
    expect(toasts[0]!.message).toContain("press e");
  });
});

describe("experiment lines", () => {
  it("states plainly when no candidate is confirmed", () => {
    expect(text(experimentLines(experiment()))).toContain("Candidate revision: not confirmed yet");
  });
});

describe("keymaps", () => {
  it("adds `e` to the analysis panel without taking an existing key", () => {
    const source = readFileSync(new URL("../src/tui/Analysis.tsx", import.meta.url), "utf8");
    const binds = [...source.matchAll(/bind: "([^"]+)"/g)].map((m) => m[1]!);
    expect(binds.sort()).toEqual(["e", "escape", "f", "n", "r"]);
    expect(new Set(binds).size).toBe(binds.length);
  });

  it("registers the two new slash commands next to the existing ones", () => {
    const source = readFileSync(new URL("../src/tui/index.tsx", import.meta.url), "utf8");
    const slashes = [...source.matchAll(/slash: \{ name: "([^"]+)" \}/g)].map((m) => m[1]!);
    expect(slashes).toEqual(expect.arrayContaining(["context", "context-analyze", "context-review", "context-unread", "context-collapse", "context-browse", "context-experiments", "context-evaluate"]));
    expect(new Set(slashes).size).toBe(slashes.length);
  });
});
