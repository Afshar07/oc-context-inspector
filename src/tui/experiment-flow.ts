import type { Plugin } from "@opencode/plugin/tui";
import {
  EAdherence,
  EExperimentRole,
  EExperimentStatus,
  ESessionFit,
  ETaskOutcome,
  type IExperiment,
  type IExperimentOrigin,
  type ISessionOffer,
} from "../evaluation/types.js";
import { ECoverageStatus, type IFileCoverage } from "../types.js";
import { diffSummary, experimentLines, experimentOption, FIT_LABEL, offerOption, short, statusLabel } from "./evaluation-format.js";
import type { IExperimentClient, Reply } from "./experiment-client.js";
import { STATUS_GLYPH } from "./format.js";

const DONE = "\u0000done";
const NEW = "\u0000new";

const toast = (ctx: Plugin.Context, variant: "info" | "warning" | "error", message: string) => ctx.ui.toast.show({ variant, message });

/** Shows an error reply and returns undefined; passes a good reply through. */
function ok<T>(ctx: Plugin.Context, reply: Reply<T>): T | undefined {
  if (reply.ok) return reply.value;
  toast(ctx, "error", reply.error);
  return undefined;
}

const plain = (lines: readonly { readonly text: string }[]) => lines.map((l) => l.text).join("\n");

/**
 * Multi-choice on top of the single-choice dialog: each pick toggles an option and reopens the dialog,
 * until "Done". Cancelling (escape) returns undefined and changes nothing.
 */
export async function pickMany(
  ctx: Plugin.Context,
  input: {
    readonly title: string;
    readonly placeholder?: string;
    readonly options: readonly { readonly title: string; readonly value: string; readonly description?: string; readonly footer?: string; readonly category?: string }[];
    readonly initial: ReadonlySet<string>;
    /** Decorates an option for its selected state. */
    readonly decorate?: (value: string, selected: boolean) => Partial<{ title: string; description: string; footer: string }>;
  },
): Promise<string[] | undefined> {
  const chosen = new Set(input.initial);
  let current: string | undefined;
  for (;;) {
    const picked = await ctx.ui.dialog.select<string>({
      title: `${input.title} (${chosen.size} selected)`,
      ...(input.placeholder !== undefined && { placeholder: input.placeholder }),
      ...(current !== undefined && { current }),
      options: [
        { title: `▶ Done: keep ${chosen.size} selected`, value: DONE },
        ...input.options.map((o) => {
          const selected = chosen.has(o.value);
          const option = { ...o, ...input.decorate?.(o.value, selected) };
          return { ...option, title: `${selected ? "✓" : "○"} ${option.title}` };
        }),
      ],
    });
    if (picked === undefined) return undefined;
    if (picked === DONE) return input.options.map((o) => o.value).filter((v) => chosen.has(v));
    if (!chosen.delete(picked)) chosen.add(picked);
    current = picked;
  }
}

export interface IExperimentFlows {
  /** Starts the create-experiment dialogs from an analysis panel. */
  createFromAnalysis(sessionID: string, origin: IExperimentOrigin, defaultFiles: readonly IFileCoverage[]): Promise<void>;
  /** `/context-experiments`: list, inspect and manage. */
  manage(sessionID: string): Promise<void>;
  /** `/context-evaluate`: choose an experiment; resolves to its id, or undefined when cancelled. */
  chooseForEvaluation(sessionID: string): Promise<string | undefined>;
}

export interface IExperimentFlowDeps {
  /** Context files of a session with their coverage, for choosing targets. Undefined when unavailable. */
  readonly coverageFiles: (sessionID: string) => Promise<readonly IFileCoverage[] | undefined>;
  readonly openEvaluation: (id: string) => void;
}

export function experimentFlows(ctx: Plugin.Context, client: IExperimentClient, { coverageFiles, openEvaluation }: IExperimentFlowDeps): IExperimentFlows {
  const titleOf = (id: string) => ctx.data.session.get(id)?.title;

  async function createFromAnalysis(sessionID: string, origin: IExperimentOrigin, files: readonly IFileCoverage[]) {
    if (files.length === 0) {
      toast(ctx, "warning", "No context files to test");
      return;
    }
    const name = await ctx.ui.dialog.prompt({
      title: "New context experiment: name",
      description: "A short name for the change you want to test",
      placeholder: "e.g. Routing table for style rules",
    });
    if (name === undefined) return;
    const hypothesis = await ctx.ui.dialog.prompt({
      title: "New context experiment: hypothesis",
      description: "What do you expect to change in how agents behave?",
      placeholder: "e.g. Agents read .ai/style.md before editing code",
    });
    if (hypothesis === undefined) return;
    // Files the review's session did not fully read are the likely subjects; the user decides.
    const likely = new Set(
      files.filter((f) => f.status === ECoverageStatus.Unread || f.status === ECoverageStatus.Partial || f.status === ECoverageStatus.Error).map((f) => f.filePath),
    );
    const targets = await pickMany(ctx, {
      title: "Context files this experiment is about",
      placeholder: "Filter files",
      initial: likely,
      options: files.map((f) => ({ title: `${STATUS_GLYPH[f.status]} ${f.filePath}`, value: f.filePath, description: f.status })),
    });
    if (targets === undefined) return;
    const taskCategory = await ctx.ui.dialog.prompt({
      title: "New context experiment: task category (optional)",
      description: "Which kind of task should be compared? Free text; you choose the sessions yourself.",
      placeholder: "e.g. bug fixes in the API layer",
    });
    if (taskCategory === undefined) return;

    const created = ok(
      ctx,
      await client.create(sessionID, {
        name,
        hypothesis,
        targetFiles: targets,
        ...(taskCategory.trim() !== "" && { taskCategory }),
        origin,
      }),
    );
    if (!created) return;
    const offers = ok(ctx, await client.offers(sessionID, created.id));
    const matching = offers?.filter((o) => o.fit === ESessionFit.Baseline).length ?? 0;
    toast(
      ctx,
      "info",
      `Experiment saved (baseline ${short(created.baseline.revisionId)}, ${matching} existing session(s) match). Edit the docs yourself, then confirm the change in /context-experiments.`,
    );
  }

  async function selectExperiment(sessionID: string, title: string, includeNew: boolean): Promise<string | undefined> {
    const { experiments, unreadable } = await client.list(sessionID);
    const open = [...experiments].sort((a, b) => Number(a.status === EExperimentStatus.Closed) - Number(b.status === EExperimentStatus.Closed));
    if (open.length === 0 && !includeNew) {
      toast(ctx, "info", "No experiments yet. Create one from /context-analyze or /context-review (press e).");
      return undefined;
    }
    return ctx.ui.dialog.select<string>({
      title: unreadable > 0 ? `${title} (${unreadable} unreadable file(s) skipped)` : title,
      placeholder: "Search experiments",
      options: [...(includeNew ? [{ title: "＋ New experiment…", value: NEW, description: "Pick files from this session's coverage" }] : []), ...open.map(experimentOption)],
    });
  }

  async function chooseForEvaluation(sessionID: string) {
    const id = await selectExperiment(sessionID, "Evaluate which experiment?", false);
    return id === undefined || id === NEW ? undefined : id;
  }

  async function manage(sessionID: string) {
    for (;;) {
      const id = await selectExperiment(sessionID, "Context experiments", true);
      if (id === undefined) return;
      if (id === NEW) {
        const files = await coverageFiles(sessionID);
        if (files) await createFromAnalysis(sessionID, { kind: "manual", sessionID }, files);
        continue;
      }
      const leave = await experimentMenu(sessionID, id);
      if (leave) return;
    }
  }

  /** One experiment's actions. Resolves true to leave the whole flow (evaluation was opened). */
  async function experimentMenu(sessionID: string, id: string): Promise<boolean> {
    for (;;) {
      const experiment = (await client.list(sessionID)).experiments.find((e) => e.id === id);
      if (!experiment) {
        toast(ctx, "warning", "Experiment not found");
        return false;
      }
      const closed = experiment.status === EExperimentStatus.Closed;
      const action = await ctx.ui.dialog.select<string>({
        title: `${experiment.name} · ${statusLabel(experiment.status)}`,
        options: [
          { title: "Inspect", value: "inspect", description: "Hypothesis, revisions, sessions, stored evaluations" },
          { title: "Evaluate", value: "evaluate", description: "Compare baseline and candidate sessions" },
          ...(closed
            ? []
            : [
                { title: "Check for the documentation change", value: "candidate", description: "Compare the target files with the baseline and confirm the candidate revision" },
                { title: "Select baseline sessions", value: "baseline", description: "Sessions that ran before the change" },
                ...(experiment.candidate ? [{ title: "Select candidate sessions", value: "candidate-sessions", description: "Sessions that ran after the change" }] : []),
                ...(experiment.sessions.length > 0 ? [{ title: "Label a session's outcome", value: "label", description: "Your own judgment; counted only with a note or evidence" }] : []),
                { title: "Close experiment", value: "close", description: "Stop measuring; the record is kept" },
              ]),
        ],
      });
      if (action === undefined) return false;
      switch (action) {
        case "inspect":
          await ctx.ui.dialog.alert({ title: "Experiment", message: plain(experimentLines(experiment)) });
          break;
        case "evaluate":
          openEvaluation(id);
          return true;
        case "candidate":
          await confirmCandidate(sessionID, experiment);
          break;
        case "baseline":
          await selectSessions(sessionID, experiment, EExperimentRole.Baseline);
          break;
        case "candidate-sessions":
          await selectSessions(sessionID, experiment, EExperimentRole.Candidate);
          break;
        case "label":
          await labelSession(sessionID, experiment);
          break;
        case "close": {
          const sure = await ctx.ui.dialog.confirm({ title: "Close experiment?", message: `"${experiment.name}" stops accepting changes. Its record and evaluations stay.` });
          if (!sure) break;
          const reason = await ctx.ui.dialog.prompt({ title: "Reason (optional)", placeholder: "e.g. superseded by a larger rewrite" });
          if (reason === undefined) break;
          if (ok(ctx, await client.close(sessionID, id, reason))) toast(ctx, "info", "Experiment closed");
          break;
        }
      }
    }
  }

  async function confirmCandidate(sessionID: string, experiment: IExperiment) {
    const detection = ok(ctx, await client.detectCandidate(sessionID, experiment.id));
    if (!detection) return;
    if (!detection.changed) {
      await ctx.ui.dialog.alert({
        title: "No change to the target files",
        message: `The target files are identical to the baseline (${short(experiment.baseline.revisionId)}). Edit the documentation first${
          detection.otherChanges.length > 0 ? `.\n\nOther context files differ: ${detection.otherChanges.join(", ")}` : "."
        }`,
      });
      return;
    }
    if (detection.alreadyConfirmed) {
      toast(ctx, "info", "This revision is already the candidate");
      return;
    }
    const others =
      detection.otherChanges.length > 0
        ? `\n\nOther context files also changed. That confounds the comparison and the verdict will be inconclusive:\n${detection.otherChanges.join("\n")}`
        : "";
    const yes = await ctx.ui.dialog.confirm({
      title: `Use revision ${short(detection.revisionId)} as the candidate?`,
      message: `Changes to target files since the baseline:\n${diffSummary(detection.targetChanges)}${others}`,
      label: { confirm: "Confirm candidate", cancel: "Not yet" },
    });
    if (!yes) return;
    if (ok(ctx, await client.confirmCandidate(sessionID, experiment.id, detection.revisionId))) {
      toast(ctx, "info", `Candidate revision ${short(detection.revisionId)} confirmed. Sessions that start now are candidate sessions.`);
    }
  }

  async function selectSessions(sessionID: string, experiment: IExperiment, role: EExperimentRole) {
    const offers = ok(ctx, await client.offers(sessionID, experiment.id));
    if (!offers) return;
    const wanted = role === EExperimentRole.Baseline ? ESessionFit.Baseline : ESessionFit.Candidate;
    const byId = new Map(offers.map((o) => [o.sessionID, o]));
    // Sessions that match the role by revision first (the suggestions), then the rest, so nothing is hidden.
    const ordered = [...offers].sort((a, b) => Number(b.fit === wanted) - Number(a.fit === wanted) || (b.firstSeenAt ?? "").localeCompare(a.firstSeenAt ?? ""));
    const current = new Set(experiment.sessions.filter((s) => s.role === role).map((s) => s.sessionID));
    const picked = await pickMany(ctx, {
      title: role === EExperimentRole.Baseline ? "Baseline sessions" : "Candidate sessions",
      placeholder: "Search sessions · matching revisions are listed first",
      initial: current,
      options: ordered.map((o) => ({ title: titleOf(o.sessionID) ?? o.sessionID, value: o.sessionID })),
      decorate: (value, selected) => {
        const offer = byId.get(value)!;
        const { title, description, footer } = offerOption(offer, titleOf(value), selected);
        return { title, description, ...(footer !== undefined && { footer }) };
      },
    });
    if (picked === undefined) return;
    const mismatched = picked.filter((id) => byId.get(id)?.fit !== wanted);
    if (mismatched.length > 0) {
      const keep = await ctx.ui.dialog.confirm({
        title: "Some sessions do not match this role",
        message: `${mismatched.length} selected session(s) did not start on the ${role} revision (${mismatched
          .slice(0, 5)
          .map((id) => `${titleOf(id) ?? id}: ${FIT_LABEL[byId.get(id)?.fit ?? ESessionFit.Unknown]}`)
          .join("; ")}). They stay selected but are listed as excluded in the evaluation.`,
        label: { confirm: "Keep them", cancel: "Cancel" },
      });
      if (!keep) return;
    }
    const add = picked.filter((id) => !current.has(id)).map((id) => ({ sessionID: id, role }));
    const remove = [...current].filter((id) => !picked.includes(id));
    if (add.length === 0 && remove.length === 0) return;
    if (ok(ctx, await client.setSessions(sessionID, experiment.id, { add, remove }))) toast(ctx, "info", `${picked.length} ${role} session(s) selected`);
  }

  async function labelSession(sessionID: string, experiment: IExperiment) {
    const target = await ctx.ui.dialog.select<string>({
      title: "Label which session?",
      options: experiment.sessions.map((s) => ({
        title: titleOf(s.sessionID) ?? s.sessionID,
        value: s.sessionID,
        description: `${s.role} · ${s.outcome ? "labeled" : "unlabeled"}`,
      })),
    });
    if (target === undefined) return;
    const outcome = await ctx.ui.dialog.select<string>({
      title: "Did the task succeed? (your judgment)",
      options: [
        { title: "Success", value: ETaskOutcome.Success },
        { title: "Failure", value: ETaskOutcome.Failure },
        { title: "Don't know", value: ETaskOutcome.Unknown, description: "Stays unknown; not counted" },
        { title: "Remove this session's label", value: "clear" },
      ],
    });
    if (outcome === undefined) return;
    if (outcome === "clear") {
      if (ok(ctx, await client.label(sessionID, experiment.id, target, { clear: true }))) toast(ctx, "info", "Label removed");
      return;
    }
    const adherence = await ctx.ui.dialog.select<string>({
      title: "Did the agent follow the instructions? (your judgment)",
      options: [
        { title: "Followed", value: EAdherence.Followed },
        { title: "Not followed", value: EAdherence.NotFollowed },
        { title: "Don't know", value: EAdherence.Unknown },
      ],
    });
    if (adherence === undefined) return;
    const note = await ctx.ui.dialog.prompt({ title: "Why? (counted only with a note or evidence)", placeholder: "e.g. tests passed in CI; used spaces as the style file says" });
    if (note === undefined) return;
    const evidenceRef = await ctx.ui.dialog.prompt({ title: "Evidence reference (optional)", placeholder: "e.g. PR link or CI run" });
    if (evidenceRef === undefined) return;
    const saved = ok(
      ctx,
      await client.label(sessionID, experiment.id, target, {
        taskSuccess: outcome as ETaskOutcome,
        adherence: adherence as EAdherence,
        note,
        evidenceRef,
      }),
    );
    if (saved) toast(ctx, "info", note.trim() === "" && evidenceRef.trim() === "" ? "Saved, but without a note or evidence it is not counted in rates" : "Label saved");
  }

  return { createFromAnalysis, manage, chooseForEvaluation };
}
