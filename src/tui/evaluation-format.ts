import {
  EExclusionReason,
  EExperimentRole,
  EExperimentStatus,
  EMetricKind,
  EMetricUnit,
  ERevisionState,
  ESessionFit,
  EVerdict,
  type IEvaluationResult,
  type IExperiment,
  type IMetricComparison,
  type IMetricSide,
  type IOutcomeLabel,
  type IRevisionDiff,
  type ISessionOffer,
} from "../evaluation/types.js";

export type Tone = "base" | "muted" | "faint" | "success" | "warning" | "error" | "info";

export interface IViewLine {
  readonly text: string;
  readonly tone?: Tone;
  readonly bold?: boolean;
}

export const short = (revisionId: string | undefined) => (revisionId === undefined ? "—" : revisionId.slice(0, 8));
const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);
const pad = (text: string, width: number) => (text.length >= width ? text : text + " ".repeat(width - text.length));
const signed = (n: number, digits = 0) => `${n > 0 ? "+" : n < 0 ? "−" : ""}${Math.abs(n).toFixed(digits)}`;

/** A fraction shown as a percentage. */
export const percent = (fraction: number) => `${Math.round(fraction * 100)}%`;

/** One side of a metric: the value with its sample, or a dash when nothing can be said. */
export function formatSide(metric: IMetricComparison, side: IMetricSide): string {
  if (side.value === undefined) return side.n === 0 ? "—" : "n/a";
  switch (metric.unit) {
    case EMetricUnit.Mean:
      return `${side.value.toFixed(1)} (n=${side.n})`;
    case EMetricUnit.Ratio:
      return `${percent(side.value)} (${side.numerator}/${side.denominator} lines)`;
    case EMetricUnit.Rate:
      return `${percent(side.value)} (${side.numerator}/${side.denominator})`;
  }
}

/**
 * The change between sides. Rates and ratios change in percentage points (pp); the relative change, a
 * percentage of the baseline, is shown beside it only when the baseline is not zero. Means change in units.
 */
export function formatChange(metric: IMetricComparison): string {
  if (metric.absoluteChange === undefined) return "—";
  const relative = metric.relativeChange === undefined ? "" : ` (${signed(metric.relativeChange * 100)}% rel.)`;
  if (metric.unit === EMetricUnit.Mean) return `${signed(metric.absoluteChange, 1)}${relative}`;
  return `${signed(metric.absoluteChange * 100)} pp${relative}`;
}

export const VERDICT_LABEL: Readonly<Record<EVerdict, string>> = {
  [EVerdict.Improved]: "improved",
  [EVerdict.Regressed]: "regressed",
  [EVerdict.Unchanged]: "unchanged",
  [EVerdict.Inconclusive]: "inconclusive",
};

export const verdictTone = (verdict: EVerdict | undefined): Tone =>
  verdict === EVerdict.Improved ? "success" : verdict === EVerdict.Regressed ? "error" : verdict === EVerdict.Inconclusive ? "warning" : "muted";

const EXCLUSION_LABEL: Readonly<Record<EExclusionReason, string>> = {
  [EExclusionReason.SessionNotFound]: "session not found",
  [EExclusionReason.UnknownRevision]: "unknown revision",
  [EExclusionReason.MixedRevision]: "context changed during the session",
  [EExclusionReason.RevisionMismatch]: "ran under another revision",
  [EExclusionReason.OtherContextDiffers]: "other context files differ",
  [EExclusionReason.NoCandidate]: "no candidate revision yet",
  [EExclusionReason.RecordsUnreadable]: "read records unreadable",
};

/** The two verdicts on one line, or the single legacy verdict of a result stored before they were separated. */
export function verdictSummary(verdict: IEvaluationResult["verdict"]): string {
  if (verdict.discovery === undefined) return VERDICT_LABEL[verdict.verdict];
  return `discovery ${VERDICT_LABEL[verdict.discovery]} · task effectiveness ${verdict.verdict === EVerdict.Inconclusive ? "unknown" : VERDICT_LABEL[verdict.verdict]}`;
}

export const FIT_LABEL: Readonly<Record<ESessionFit, string>> = {
  [ESessionFit.Baseline]: "baseline revision",
  [ESessionFit.Candidate]: "candidate revision",
  [ESessionFit.OtherContextDiffers]: "target files match, other context differs",
  [ESessionFit.Other]: "another revision",
  [ESessionFit.Mixed]: "context changed during the session",
  [ESessionFit.Unknown]: "revision unknown",
};

const STATUS_LABEL: Readonly<Record<EExperimentStatus, string>> = {
  [EExperimentStatus.AwaitingCandidate]: "awaiting the documentation change",
  [EExperimentStatus.Measuring]: "measuring",
  [EExperimentStatus.Closed]: "closed",
};

export const statusLabel = (status: EExperimentStatus) => STATUS_LABEL[status];

/** Picker row for an experiment. */
export function experimentOption(experiment: IExperiment) {
  return {
    title: experiment.name,
    value: experiment.id,
    description: `${statusLabel(experiment.status)} · ${clip(experiment.hypothesis, 70)}`,
    footer: `${short(experiment.baseline.revisionId)} → ${short(experiment.candidate?.revisionId)} · ${experiment.sessions.length} sessions`,
  };
}

/** Picker row for a lead session offered to an experiment. `selected`: already in this role, so its role is not repeated. */
export function offerOption(offer: ISessionOffer, title: string | undefined, selected: boolean) {
  const parts = [FIT_LABEL[offer.fit]];
  if (offer.revisionState === ERevisionState.Unknown && offer.fit !== ESessionFit.Unknown) parts.push("revision unknown");
  if (offer.descendants > 0) parts.push(`+${offer.descendants} sub`);
  if (offer.selectedRole && !selected) parts.push(offer.selectedRole);
  return {
    title: clip(title ?? offer.sessionID, 48),
    value: offer.sessionID,
    description: parts.join(" · "),
    footer: offer.firstSeenAt ? offer.firstSeenAt.slice(0, 16).replace("T", " ") : short(offer.sessionID),
  };
}

const diffSummary = (diff: IRevisionDiff) =>
  [
    ...diff.modified.map((p) => `~ ${p}`),
    ...diff.added.map((p) => `+ ${p}`),
    ...diff.removed.map((p) => `− ${p}`),
    ...diff.renamed.map((r) => `${r.from} → ${r.to}`),
  ].join("\n");

export { diffSummary };

function labelText(label: IOutcomeLabel | undefined): string {
  if (!label) return "unlabeled";
  const parts = [
    label.taskSuccess ? `outcome ${label.taskSuccess}` : undefined,
    label.adherence ? `adherence ${label.adherence}` : undefined,
    label.note ? `“${clip(label.note, 40)}”` : undefined,
    label.evidenceRef ? `ref ${clip(label.evidenceRef, 30)}` : undefined,
  ].filter(Boolean);
  return parts.join(" · ") || "unlabeled";
}

/** Facts about an experiment: what it tests, what it is anchored to, and who is in it. */
export function experimentLines(experiment: IExperiment): IViewLine[] {
  const lines: IViewLine[] = [
    { text: experiment.name, bold: true },
    { text: `Status: ${statusLabel(experiment.status)}${experiment.closedReason ? ` — ${experiment.closedReason}` : ""}`, tone: "muted" },
    { text: `Hypothesis: ${experiment.hypothesis}` },
    { text: `Target files: ${experiment.targetFiles.join(", ")}` },
  ];
  if (experiment.criteria.taskCategory) lines.push({ text: `Task category: ${experiment.criteria.taskCategory}` });
  if (experiment.criteria.description) lines.push({ text: `Eligibility: ${experiment.criteria.description}` });
  lines.push({
    text: `Baseline revision ${short(experiment.baseline.revisionId)} (${experiment.baseline.capturedAt.slice(0, 16).replace("T", " ")})`,
    tone: "muted",
  });
  lines.push({
    text: experiment.candidate
      ? `Candidate revision ${short(experiment.candidate.revisionId)} (${experiment.candidate.capturedAt.slice(0, 16).replace("T", " ")})`
      : "Candidate revision: not confirmed yet. Edit the documentation, then confirm the change.",
    tone: experiment.candidate ? "muted" : "warning",
  });
  const roles = [EExperimentRole.Baseline, EExperimentRole.Candidate] as const;
  for (const role of roles) {
    const sessions = experiment.sessions.filter((s) => s.role === role);
    lines.push({ text: `${role === EExperimentRole.Baseline ? "Baseline" : "Candidate"} sessions: ${sessions.length}`, tone: "muted" });
    for (const s of sessions) lines.push({ text: `  ${s.sessionID} · ${labelText(s.outcome)}`, tone: "faint" });
  }
  const last = experiment.evaluations[experiment.evaluations.length - 1];
  if (last) {
    lines.push({
      text: `Last evaluation ${last.evaluatedAt.slice(0, 16).replace("T", " ")}: ${verdictSummary(last.verdict)} (${experiment.evaluations.length} stored)`,
      tone: verdictTone(last.verdict.verdict),
    });
  }
  return lines;
}

const SECTION_TITLES: Readonly<Record<string, string>> = {
  discovery: "Context discovery (did agents read the files? not whether they did better)",
  efficiency: "Context-reading efficiency (signals, no verdict)",
  verification: "Verification evidence (signals, no verdict)",
  outcome: "Human-labeled outcomes",
};

function metricRow(metric: IMetricComparison): IViewLine[] {
  const verdict = metric.verdict === undefined ? "signal" : VERDICT_LABEL[metric.verdict];
  const rows: IViewLine[] = [
    {
      text: `  ${pad(clip(metric.label, 38), 38)} ${pad(formatSide(metric, metric.baseline), 20)} ${pad(formatSide(metric, metric.candidate), 20)} ${pad(formatChange(metric), 18)} ${verdict}`,
      tone: metric.verdict === undefined ? "base" : verdictTone(metric.verdict),
    },
  ];
  const missing = [
    metric.baseline.missing > 0 ? `${metric.baseline.missing} baseline` : undefined,
    metric.candidate.missing > 0 ? `${metric.candidate.missing} candidate` : undefined,
  ].filter(Boolean);
  if (missing.length > 0) rows.push({ text: `    no evidence for: ${missing.join(", ")}`, tone: "faint" });
  return rows;
}

/**
 * The evaluation as lines for the panel. Observed measurements and human labels are in separate sections,
 * and an improved verdict names the metrics behind it instead of claiming general improvement.
 */
export function evaluationLines(result: IEvaluationResult, experiment: IExperiment | undefined): IViewLine[] {
  const lines: IViewLine[] = [];
  if (experiment) lines.push({ text: `${experiment.name} · ${statusLabel(experiment.status)}`, bold: true });
  if (experiment) lines.push({ text: `Hypothesis: ${experiment.hypothesis}`, tone: "muted" });
  lines.push({
    text: `Baseline ${short(result.baselineRevisionId)} → candidate ${short(result.candidateRevisionId)} · targets: ${(experiment?.targetFiles ?? []).join(", ") || "—"}`,
    tone: "muted",
  });

  const { verdict } = result;
  const names = (ids: readonly string[]) => ids.map((id) => result.metrics.find((m) => m.id === id)?.label ?? id).join("; ");
  lines.push({ text: "" });
  if (verdict.discovery === undefined) {
    // Stored before discovery and effectiveness were separated: show it as recorded, with a caution.
    lines.push({ text: `Verdict: ${VERDICT_LABEL[verdict.verdict]} (older evaluation; discovery and task effectiveness were not separated)`, tone: verdictTone(verdict.verdict), bold: true });
  } else {
    lines.push({ text: `Discovery: ${VERDICT_LABEL[verdict.discovery]}`, tone: verdictTone(verdict.discovery), bold: true });
    lines.push({
      text: `Task effectiveness: ${verdict.verdict === EVerdict.Inconclusive ? "unknown (inconclusive)" : VERDICT_LABEL[verdict.verdict]}`,
      tone: verdictTone(verdict.verdict),
      bold: true,
    });
  }
  if (verdict.improved.length > 0) lines.push({ text: `  improved: ${names(verdict.improved)}`, tone: "success" });
  if (verdict.regressed.length > 0) lines.push({ text: `  regressed: ${names(verdict.regressed)}`, tone: "error" });
  for (const reason of verdict.reasons) lines.push({ text: `  ${reason}`, tone: "muted" });

  const baseline = result.groups.filter((g) => g.role === EExperimentRole.Baseline).length;
  const candidate = result.groups.filter((g) => g.role === EExperimentRole.Candidate).length;
  lines.push({ text: `Samples (lead sessions, subagents grouped): baseline ${baseline} · candidate ${candidate} · excluded ${result.exclusions.length}`, tone: "muted" });
  lines.push({ text: "" });
  lines.push({
    text: `${pad("", 40)}${pad("baseline", 21)}${pad("candidate", 21)}${pad("change", 19)}verdict`,
    tone: "faint",
  });

  for (const kind of [EMetricKind.Observed, EMetricKind.Labeled]) {
    const metrics = result.metrics.filter((m) => m.kind === kind);
    if (kind === EMetricKind.Observed) lines.push({ text: "Observed (counted from recorded evidence)", bold: true });
    else lines.push({ text: "Human-labeled (typed by you; counted only with a note or evidence)", bold: true });
    let lastGroup: string | undefined;
    for (const metric of metrics) {
      if (metric.group !== lastGroup) {
        lines.push({ text: SECTION_TITLES[metric.group] ?? metric.group, tone: "info" });
        lastGroup = metric.group;
      }
      lines.push(...metricRow(metric));
    }
  }

  if (result.exclusions.length > 0) {
    lines.push({ text: "" });
    lines.push({ text: "Excluded sessions", bold: true });
    for (const e of result.exclusions) {
      lines.push({ text: `  ${e.sessionID} (${e.role}): ${EXCLUSION_LABEL[e.reason]}${e.detail ? ` — ${clip(e.detail, 90)}` : ""}`, tone: "warning" });
    }
  }

  const ctx = result.context;
  lines.push({ text: "" });
  lines.push({ text: "Comparison context", bold: true });
  lines.push({ text: `  models: baseline ${ctx.baselineModels.join(", ") || "unknown"} · candidate ${ctx.candidateModels.join(", ") || "unknown"}`, tone: "muted" });
  const status = (comparable: boolean | undefined, what: string): IViewLine =>
    comparable === undefined
      ? { text: `  ${what}: unknown for at least one session — comparability cannot be confirmed`, tone: "warning" }
      : comparable
        ? { text: `  ${what}: same on both sides`, tone: "muted" }
        : { text: `  ${what}: differ between the sides`, tone: "warning" };
  lines.push(status(ctx.modelsComparable, "models"), status(ctx.environmentsComparable, "plugin configuration"));
  for (const role of ctx.missingAnchors ?? []) lines.push({ text: `  ${role} revision snapshot missing or damaged — other context changes cannot be ruled out`, tone: "warning" });
  const changed = diffSummary(ctx.targetChanges);
  if (changed) for (const row of changed.split("\n")) lines.push({ text: `  target change ${row}`, tone: "muted" });
  for (const path of ctx.nonTargetChanges) lines.push({ text: `  other context changed: ${path}`, tone: "warning" });

  lines.push({ text: "" });
  lines.push({ text: "What this cannot show", bold: true });
  for (const limitation of result.limitations) lines.push({ text: `  • ${limitation}`, tone: "muted" });
  return lines;
}

/** One-line summary of a session's revision for toasts and pickers. */
export function revisionLine(state: ERevisionState, startRevisionId: string | undefined, reason: string | undefined): string {
  if (state === ERevisionState.Stable) return `stable on ${short(startRevisionId)}`;
  return `${state}${reason ? `: ${reason}` : ""}`;
}
