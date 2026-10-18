import {
  EAdherence,
  ECompleteness,
  EMissing,
  EMetricKind,
  EMetricUnit,
  ETaskOutcome,
  EVerdict,
  type IComparisonContext,
  type IGroupMeasurement,
  type IMetricComparison,
  type IMetricSide,
  type IEvaluationSettings,
  type IOutcomeLabel,
  type IOverallVerdict,
  type MetricGroup,
} from "./types.js";

export const DEFAULT_SETTINGS: IEvaluationSettings = { minSamples: 3, rateThreshold: 0.2 };

/** A label counts toward a rate only with an explanation or an evidence pointer, so a bare click proves nothing. */
export const isGrounded = (label: IOutcomeLabel | undefined): label is IOutcomeLabel =>
  label !== undefined && ((label.note ?? "").trim() !== "" || (label.evidenceRef ?? "").trim() !== "");

/** What one group contributes to a metric. */
type Contribution =
  /** Missing: the group cannot say. */
  | undefined
  | { readonly numerator: number; readonly denominator: number };

interface IMetricSpec {
  readonly id: string;
  readonly label: string;
  readonly group: MetricGroup;
  readonly kind: EMetricKind;
  readonly unit: EMetricUnit;
  /** A verdict is defensible: more is better and the evidence is a fact or a grounded label. */
  readonly directional: boolean;
  readonly note?: string;
  readonly contribute: (g: IGroupMeasurement) => Contribution;
}

const flag = (value: boolean | undefined): Contribution => (value === undefined ? undefined : { numerator: value ? 1 : 0, denominator: 1 });
const count = (value: number): Contribution => ({ numerator: value, denominator: 1 });

/** Metric definitions. Rates and ratios are numerator/denominator; means divide by contributing sessions. */
const SPECS: readonly IMetricSpec[] = [
  {
    id: "discovery.explicit-read",
    label: "Sessions that read a target file",
    group: "discovery",
    kind: EMetricKind.Observed,
    unit: EMetricUnit.Rate,
    directional: true,
    note: "Explicit tool reads only. Files OpenCode injects itself are invisible to the hooks, so no read is not proof the agent lacked the content.",
    // When every target is auto-loaded, absence of a read says nothing.
    contribute: (g) => (g.explicitTargetRead ? flag(true) : g.readBeforeActionMissing === EMissing.AutoLoadedOnly ? undefined : flag(false)),
  },
  {
    id: "discovery.read-before-action",
    label: "Target read before the first file change",
    group: "discovery",
    kind: EMetricKind.Observed,
    unit: EMetricUnit.Rate,
    directional: true,
    note: "Among sessions that read a target file and changed files, with the message log available.",
    contribute: (g) => flag(g.readBeforeAction),
  },
  {
    id: "discovery.complete-read",
    label: "Target files read completely",
    group: "discovery",
    kind: EMetricKind.Observed,
    unit: EMetricUnit.Rate,
    directional: true,
    note: "Among sessions that read a target file; judged against the file as it was read.",
    contribute: (g) => (g.completeness === ECompleteness.Full ? flag(true) : g.completeness === ECompleteness.Partial ? flag(false) : undefined),
  },
  {
    id: "efficiency.repeat-reads",
    label: "Repeat reads of target files (same agent)",
    group: "efficiency",
    kind: EMetricKind.Observed,
    unit: EMetricUnit.Mean,
    directional: false,
    note: "A repeat is a signal, not a defect: an agent may re-read after a long task.",
    contribute: (g) => count(g.repeatReads),
  },
  {
    id: "efficiency.cross-agent-rereads",
    label: "Cross-agent rereads of target files",
    group: "efficiency",
    kind: EMetricKind.Observed,
    unit: EMetricUnit.Mean,
    directional: false,
    contribute: (g) => count(g.crossAgentRereads),
  },
  {
    id: "efficiency.failed-reads",
    label: "Failed reads of target files",
    group: "efficiency",
    kind: EMetricKind.Observed,
    unit: EMetricUnit.Mean,
    directional: false,
    contribute: (g) => count(g.failedReads),
  },
  {
    id: "efficiency.delivered-vs-requested",
    label: "Lines delivered / lines requested",
    group: "efficiency",
    kind: EMetricKind.Observed,
    unit: EMetricUnit.Ratio,
    directional: false,
    note: "Only reads that passed an explicit limit and have a delivery record.",
    contribute: (g) => (g.requestedLines > 0 ? { numerator: g.deliveredLines, denominator: g.requestedLines } : undefined),
  },
  {
    id: "efficiency.context-reads",
    label: "Context reads (all context files)",
    group: "efficiency",
    kind: EMetricKind.Observed,
    unit: EMetricUnit.Mean,
    directional: false,
    contribute: (g) => count(g.contextReads),
  },
  {
    id: "verification.ran-verification",
    label: "Sessions with a test/check/build-like command",
    group: "verification",
    kind: EMetricKind.Observed,
    unit: EMetricUnit.Rate,
    directional: false,
    note: "Matched by command name from OpenCode's message log. Says nothing about the result.",
    contribute: (g) => {
      const a = g.activity;
      if (!a) return undefined;
      return a.verificationRuns > 0 ? flag(true) : a.complete ? flag(false) : undefined;
    },
  },
  {
    id: "verification.exit-code-known",
    label: "Verification-like runs with a known exit code",
    group: "verification",
    kind: EMetricKind.Observed,
    unit: EMetricUnit.Rate,
    directional: false,
    contribute: (g) => {
      const a = g.activity;
      return a && a.verificationRuns > 0 ? { numerator: a.verificationWithExit, denominator: a.verificationRuns } : undefined;
    },
  },
  {
    id: "verification.nonzero-exit",
    label: "Verification-like runs that exited non-zero",
    group: "verification",
    kind: EMetricKind.Observed,
    unit: EMetricUnit.Rate,
    directional: false,
    note: "Among runs with a known exit code.",
    contribute: (g) => {
      const a = g.activity;
      return a && a.verificationWithExit > 0 ? { numerator: a.verificationNonZero, denominator: a.verificationWithExit } : undefined;
    },
  },
  {
    id: "outcome.task-success",
    label: "Task success (human label)",
    group: "outcome",
    kind: EMetricKind.Labeled,
    unit: EMetricUnit.Rate,
    directional: true,
    note: "Only labels with a note or evidence reference count; unlabeled sessions stay unknown.",
    contribute: (g) =>
      isGrounded(g.outcome) && (g.outcome.taskSuccess === ETaskOutcome.Success || g.outcome.taskSuccess === ETaskOutcome.Failure)
        ? flag(g.outcome.taskSuccess === ETaskOutcome.Success)
        : undefined,
  },
  {
    id: "outcome.adherence",
    label: "Instruction adherence (human label)",
    group: "outcome",
    kind: EMetricKind.Labeled,
    unit: EMetricUnit.Rate,
    directional: true,
    note: "Only labels with a note or evidence reference count; unlabeled sessions stay unknown.",
    contribute: (g) =>
      isGrounded(g.outcome) && (g.outcome.adherence === EAdherence.Followed || g.outcome.adherence === EAdherence.NotFollowed)
        ? flag(g.outcome.adherence === EAdherence.Followed)
        : undefined,
  },
];

/** Rates and ratios pool the numerators and denominators; means average per contributing session. */
function side(groups: readonly IGroupMeasurement[], spec: IMetricSpec): IMetricSide {
  const parts = groups.map((g) => spec.contribute(g));
  const known = parts.filter((p): p is { numerator: number; denominator: number } => p !== undefined);
  const missing = groups.length - known.length;
  if (known.length === 0) return { n: 0, missing };
  const numerator = known.reduce((n, p) => n + p.numerator, 0);
  const denominator = known.reduce((n, p) => n + p.denominator, 0);
  if (spec.unit === EMetricUnit.Mean) return { n: known.length, missing, value: numerator / known.length };
  return { n: known.length, missing, numerator, denominator, ...(denominator > 0 && { value: numerator / denominator }) };
}

function verdictFor(spec: IMetricSpec, baseline: IMetricSide, candidate: IMetricSide, settings: IEvaluationSettings, notes: string[]): EVerdict {
  if (baseline.n < settings.minSamples || candidate.n < settings.minSamples) {
    notes.push(`Fewer than ${settings.minSamples} sessions on a side (${baseline.n} vs ${candidate.n}).`);
    return EVerdict.Inconclusive;
  }
  if (baseline.value === undefined || candidate.value === undefined) return EVerdict.Inconclusive;
  // Rounded so 0.7 - 0.5 is the 0.2 it means, not 0.19999999999999996.
  const delta = Math.round((candidate.value - baseline.value) * 1e9) / 1e9;
  if (Math.abs(delta) < settings.rateThreshold / 2) return EVerdict.Unchanged;
  if (Math.abs(delta) < settings.rateThreshold) {
    notes.push("Difference is smaller than the threshold for a real change.");
    return EVerdict.Inconclusive;
  }
  return delta > 0 ? EVerdict.Improved : EVerdict.Regressed;
}

/**
 * Descriptive before/after comparison of two populations of groups. Not a statistical test: a verdict
 * needs enough sessions on both sides, a difference past a fixed threshold, and comparable populations.
 * Signals (efficiency, verification) are reported with their change but get no verdict.
 */
export function compareGroups(
  baselineGroups: readonly IGroupMeasurement[],
  candidateGroups: readonly IGroupMeasurement[],
  context: IComparisonContext,
  settings: IEvaluationSettings = DEFAULT_SETTINGS,
): IMetricComparison[] {
  const differences = comparabilityDifferences(context);
  const gaps = comparabilityGaps(context);
  return SPECS.map((spec): IMetricComparison => {
    const baseline = side(baselineGroups, spec);
    const candidate = side(candidateGroups, spec);
    const notes = spec.note ? [spec.note] : [];
    const absoluteChange = baseline.value !== undefined && candidate.value !== undefined ? candidate.value - baseline.value : undefined;
    const relativeChange =
      absoluteChange !== undefined && baseline.value !== undefined && baseline.value !== 0 ? absoluteChange / baseline.value : undefined;
    let verdict: EVerdict | undefined;
    if (spec.directional) {
      verdict = verdictFor(spec, baseline, candidate, settings, notes);
      // The measurements stay; only the directional claim is withdrawn.
      if (differences.length > 0 || gaps.length > 0) {
        if (differences.length > 0) notes.push(`Not comparable: ${differences.join("; ")}.`);
        if (gaps.length > 0) notes.push(`Comparability unknown: ${gaps.join("; ")}.`);
        verdict = EVerdict.Inconclusive;
      }
    }
    return {
      id: spec.id,
      label: spec.label,
      group: spec.group,
      kind: spec.kind,
      unit: spec.unit,
      directional: spec.directional,
      baseline,
      candidate,
      ...(absoluteChange !== undefined && { absoluteChange }),
      ...(relativeChange !== undefined && { relativeChange }),
      ...(verdict !== undefined && { verdict }),
      notes,
    };
  });
}

/** Confirmed reasons the two populations cannot be compared like for like. */
export function comparabilityDifferences(context: IComparisonContext): string[] {
  const problems: string[] = [];
  if (context.modelsComparable === false) {
    problems.push(`models differ (${context.baselineModels.join(", ") || "none"} vs ${context.candidateModels.join(", ") || "none"})`);
  }
  if (context.environmentsComparable === false) problems.push("plugin tracking configuration differs between the sides");
  if (context.nonTargetChanges.length > 0) {
    problems.push(`other context files also changed between the revisions (${context.nonTargetChanges.slice(0, 3).join(", ")}${context.nonTargetChanges.length > 3 ? ", …" : ""})`);
  }
  return problems;
}

/**
 * What is not known, as opposed to known to differ. Unknown is not comparable: a model or configuration
 * change nobody recorded looks exactly like no change, and a missing anchor snapshot cannot show that no other
 * context file changed.
 */
export function comparabilityGaps(context: IComparisonContext): string[] {
  const gaps: string[] = [];
  if (context.modelsComparable === undefined) gaps.push("the model is not recorded for every session on both sides");
  if (context.environmentsComparable === undefined) gaps.push("the plugin tracking configuration is not recorded for every session on both sides");
  for (const role of context.missingAnchors ?? []) {
    gaps.push(`the ${role} revision snapshot is missing or damaged, so changes to other context files cannot be ruled out`);
  }
  return gaps;
}

/** Everything that blocks a directional verdict: confirmed differences and unknowns. */
export const comparabilityProblems = (context: IComparisonContext): string[] => [
  ...comparabilityDifferences(context),
  ...comparabilityGaps(context),
];

/** The verdict of one family of directional metrics, with the metrics behind it. */
function familyVerdict(metrics: readonly IMetricComparison[]) {
  const ids = (verdict: EVerdict) => metrics.filter((m) => m.verdict === verdict).map((m) => m.id);
  const improved = ids(EVerdict.Improved);
  const regressed = ids(EVerdict.Regressed);
  const unchanged = ids(EVerdict.Unchanged);
  const noData = metrics.every((m) => m.baseline.n === 0 || m.candidate.n === 0);
  let verdict = EVerdict.Inconclusive;
  if (improved.length > 0 && regressed.length > 0) verdict = EVerdict.Inconclusive;
  else if (regressed.length > 0) verdict = EVerdict.Regressed;
  else if (improved.length > 0) verdict = EVerdict.Improved;
  else if (unchanged.length > 0 && metrics.every((m) => m.verdict === EVerdict.Unchanged || (m.baseline.n === 0 && m.candidate.n === 0))) {
    verdict = EVerdict.Unchanged;
  }
  return { verdict, improved, regressed, mixed: improved.length > 0 && regressed.length > 0, noData };
}

/**
 * Two verdicts, never blended. `discovery` says whether agents read the target files more, earlier or more
 * completely; `verdict` (task effectiveness) moves only on grounded human outcome labels. A discovery
 * improvement therefore never reads as an effectiveness improvement. Anything unknown or different about the
 * two populations withdraws both.
 */
export function overallVerdict(metrics: readonly IMetricComparison[], context: IComparisonContext): IOverallVerdict {
  const differences = comparabilityDifferences(context);
  const gaps = comparabilityGaps(context);
  if (differences.length > 0 || gaps.length > 0) {
    return {
      verdict: EVerdict.Inconclusive,
      discovery: EVerdict.Inconclusive,
      improved: [],
      regressed: [],
      reasons: [
        ...differences.map((p) => `Not comparable: ${p}.`),
        ...gaps.map((p) => `Comparability unknown: ${p}.`),
        "Task effectiveness remains unknown.",
      ],
    };
  }

  const discovery = familyVerdict(metrics.filter((m) => m.directional && m.group === "discovery"));
  const outcome = familyVerdict(metrics.filter((m) => m.directional && m.group === "outcome"));
  const reasons: string[] = [];

  if (discovery.mixed) reasons.push("Discovery: some metrics improved while others regressed.");
  else if (discovery.verdict === EVerdict.Improved) {
    reasons.push("Discovery improved: agents read the target files more, earlier or more completely. This does not show that they performed better.");
  } else if (discovery.verdict === EVerdict.Regressed) {
    reasons.push("Discovery regressed: agents read the target files less, later or less completely. This does not show that they performed worse.");
  } else if (discovery.verdict === EVerdict.Unchanged) reasons.push("Discovery: no metric moved past the threshold.");
  else reasons.push(discovery.noData ? "Discovery: no metric has data on both sides yet." : "Discovery: samples are too few, or differences too small, for a conclusion.");

  if (outcome.mixed) reasons.push("Task effectiveness: success and adherence moved in opposite directions.");
  else if (outcome.verdict === EVerdict.Improved) reasons.push("Task effectiveness: the listed human-labeled outcomes improved. Task difficulty is not controlled.");
  else if (outcome.verdict === EVerdict.Regressed) reasons.push("Task effectiveness: the listed human-labeled outcomes regressed. Task difficulty is not controlled.");
  else if (outcome.verdict === EVerdict.Unchanged) reasons.push("Task effectiveness: labeled outcomes did not move past the threshold.");
  else reasons.push("Task effectiveness remains unknown: too few grounded outcome labels (a note or evidence reference) on both sides.");

  return {
    verdict: outcome.verdict,
    discovery: discovery.verdict,
    improved: [...discovery.improved, ...outcome.improved],
    regressed: [...discovery.regressed, ...outcome.regressed],
    reasons,
  };
}

const sorted = (values: readonly string[]) => [...new Set(values)].sort();

/** Models and environments of each side. A side with any group of unknown model or environment is unknown. */
export function sideContext(
  baselineGroups: readonly IGroupMeasurement[],
  candidateGroups: readonly IGroupMeasurement[],
): Pick<IComparisonContext, "baselineModels" | "candidateModels" | "baselineEnvironments" | "candidateEnvironments" | "modelsComparable" | "environmentsComparable"> {
  const labels = (groups: readonly IGroupMeasurement[], pick: (g: IGroupMeasurement) => readonly string[]) => ({
    values: sorted(groups.flatMap(pick)),
    known: groups.length > 0 && groups.every((g) => pick(g).length > 0),
  });
  const compare = (a: ReturnType<typeof labels>, b: ReturnType<typeof labels>) =>
    a.known && b.known ? a.values.length === b.values.length && a.values.every((v, i) => v === b.values[i]) : undefined;
  const bm = labels(baselineGroups, (g) => g.models);
  const cm = labels(candidateGroups, (g) => g.models);
  const be = labels(baselineGroups, (g) => g.environments);
  const ce = labels(candidateGroups, (g) => g.environments);
  const modelsComparable = compare(bm, cm);
  const environmentsComparable = compare(be, ce);
  return {
    baselineModels: bm.values,
    candidateModels: cm.values,
    baselineEnvironments: be.values,
    candidateEnvironments: ce.values,
    ...(modelsComparable !== undefined && { modelsComparable }),
    ...(environmentsComparable !== undefined && { environmentsComparable }),
  };
}

/** Plain statements of what this evaluation cannot show. */
export function limitationsFor(
  baselineGroups: readonly IGroupMeasurement[],
  candidateGroups: readonly IGroupMeasurement[],
  context: IComparisonContext,
  exclusionCount: number,
  settings: IEvaluationSettings,
): string[] {
  const all = [...baselineGroups, ...candidateGroups];
  const out = [
    `Descriptive comparison, not a significance test. A verdict needs at least ${settings.minSamples} sessions per side and a ${Math.round(settings.rateThreshold * 100)} percentage-point difference.`,
    "Sessions were chosen by hand; task complexity and difficulty are not measured.",
    "Only explicit tool reads are observed. Files OpenCode injects itself (auto-loaded) never appear as reads.",
  ];
  if (baselineGroups.length < settings.minSamples || candidateGroups.length < settings.minSamples) {
    out.push(`Sample sizes are small (${baselineGroups.length} baseline, ${candidateGroups.length} candidate).`);
  }
  if (exclusionCount > 0) out.push(`${exclusionCount} selected session(s) were excluded; see the exclusions list.`);
  const noTimeline = all.filter((g) => !g.activity?.complete).length;
  if (noTimeline > 0) out.push(`Read-before-action and verification evidence is missing for ${noTimeline} session(s): their message log was not available.`);
  for (const p of comparabilityDifferences(context)) out.push(`Not comparable: ${p}.`);
  for (const p of comparabilityGaps(context)) out.push(`Comparability unknown, so no directional verdict: ${p}.`);
  out.push("Discovery metrics describe whether agents read the target files. They do not show that agents performed better.");
  if (all.every((g) => g.outcome === undefined)) out.push("No outcome labels were entered, so task success and instruction adherence are unknown.");
  const grounded = (groups: readonly IGroupMeasurement[]) => groups.filter((g) => isGrounded(g.outcome)).length;
  if (grounded(baselineGroups) < settings.minSamples || grounded(candidateGroups) < settings.minSamples) {
    out.push(
      `Task effectiveness remains unknown: grounded outcome labels cover ${grounded(baselineGroups)} baseline and ${grounded(candidateGroups)} candidate session(s); ${settings.minSamples} per side are needed.`,
    );
  }
  out.push("Verification metrics count command names and exit codes only; they do not show that work was correct.");
  return out;
}
