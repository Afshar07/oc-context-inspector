import { randomBytes } from "node:crypto";
import type { ContextPathMatcher } from "../matcher.js";
import type { IClock } from "../types.js";
import type { GroupResolver } from "./groups.js";
import { diffSnapshots, diffPaths, excludeDiff, isEmptyDiff, restrictDiff, scopedRevisionId, toPosix, type RevisionSnapshotter } from "./revisions.js";
import type { EvaluationStore } from "./store.js";
import {
  EAdherence,
  EExperimentRole,
  EExperimentStatus,
  ERevisionState,
  ESessionFit,
  ETaskOutcome,
  EVALUATION_SCHEMA_VERSION,
  type ExperimentEventKind,
  type IEvaluationResult,
  type IExperiment,
  type IExperimentOrigin,
  type IOutcomeLabel,
  type IRevisionDiff,
  type ISessionOffer,
} from "./types.js";

export const MAX_NAME = 80;
export const MAX_HYPOTHESIS = 500;
export const MAX_TARGETS = 50;
export const MAX_TEXT = 300;
const MAX_EVALUATIONS = 10;
const MAX_HISTORY = 100;

/** A request the user can fix (bad input, wrong state). Distinct from a fault, so callers show it plainly. */
export class ExperimentError extends Error {}

export interface ICreateExperimentInput {
  readonly name: string;
  readonly hypothesis: string;
  readonly targetFiles: readonly string[];
  readonly taskCategory?: string;
  readonly description?: string;
  /** Sessions (or their subagents) that already ran under the baseline revision. */
  readonly baselineSessionIDs?: readonly string[];
  readonly origin?: IExperimentOrigin;
}

export interface ICandidateDetection {
  /** Target files differ from the baseline. Without that, no revision can be the candidate. */
  readonly changed: boolean;
  readonly revisionId: string;
  readonly targetRevisionId: string;
  readonly targetChanges: IRevisionDiff;
  /** Context files outside the targets that also differ from the baseline: they confound the comparison. */
  readonly otherChanges: readonly string[];
  /** The experiment already points at this revision. */
  readonly alreadyConfirmed: boolean;
}

export interface ISessionChange {
  readonly add?: readonly { readonly sessionID: string; readonly role: EExperimentRole }[];
  readonly remove?: readonly string[];
}

export interface ILabelInput {
  readonly taskSuccess?: ETaskOutcome;
  readonly adherence?: EAdherence;
  readonly note?: string;
  readonly evidenceRef?: string;
  /** Remove the label. */
  readonly clear?: boolean;
}

export interface IExperimentDeps {
  readonly store: EvaluationStore;
  readonly snapshotter: RevisionSnapshotter;
  readonly matcher: ContextPathMatcher;
  readonly groups: GroupResolver;
  readonly clock?: IClock;
  readonly newId?: () => string;
}

const collapse = (text: string) => text.trim().replace(/\s+/g, " ");
const sameText = (a: string, b: string) => collapse(a).toLowerCase() === collapse(b).toLowerCase();

/**
 * Experiment lifecycle: create with a baseline, confirm a candidate revision, select sessions, label
 * outcomes, record evaluations, close. It never edits documentation or starts an agent; the user changes
 * the context files themselves. Changes to one experiment are serialized, so concurrent callers cannot lose updates.
 */
export class ExperimentService {
  private readonly store: EvaluationStore;
  private readonly clock: IClock;
  private readonly locks = new Map<string, Promise<unknown>>();

  constructor(private readonly deps: IExperimentDeps) {
    this.store = deps.store;
    this.clock = deps.clock ?? { now: () => new Date() };
  }

  private now = () => this.clock.now().toISOString();
  private newId = () => this.deps.newId?.() ?? `exp_${randomBytes(4).toString("hex")}`;

  list() {
    return this.store.listExperiments();
  }

  async get(id: string): Promise<IExperiment> {
    const experiment = await this.store.getExperiment(id);
    if (!experiment) throw new ExperimentError(`Unknown experiment: ${id}`);
    return experiment;
  }

  async create(input: ICreateExperimentInput): Promise<IExperiment> {
    const name = collapse(input.name);
    const hypothesis = collapse(input.hypothesis);
    if (name === "" || name.length > MAX_NAME) throw new ExperimentError(`Name must be 1-${MAX_NAME} characters.`);
    if (hypothesis === "" || hypothesis.length > MAX_HYPOTHESIS) throw new ExperimentError(`Hypothesis must be 1-${MAX_HYPOTHESIS} characters.`);
    const taskCategory = collapse(input.taskCategory ?? "");
    const description = collapse(input.description ?? "");
    if (taskCategory.length > MAX_NAME || description.length > MAX_TEXT) throw new ExperimentError("Criteria text is too long.");

    const targets = [...new Set(input.targetFiles.map((file) => this.normalizeTarget(file)))].sort();
    if (targets.length === 0) throw new ExperimentError("Choose at least one context file to test.");
    if (targets.length > MAX_TARGETS) throw new ExperimentError(`At most ${MAX_TARGETS} target files.`);

    const snapshot = await this.deps.snapshotter.current();
    await this.store.putSnapshot(snapshot);
    const targetRevisionId = scopedRevisionId(snapshot.files, targets);

    const { experiments } = await this.store.listExperiments();
    for (const other of experiments.filter((e) => e.status !== EExperimentStatus.Closed)) {
      if (sameText(other.name, name)) throw new ExperimentError(`An open experiment is already named "${other.name}" (${other.id}).`);
      if (
        sameText(other.hypothesis, hypothesis) &&
        other.baseline.targetRevisionId === targetRevisionId &&
        other.targetFiles.join("\0") === targets.join("\0")
      ) {
        throw new ExperimentError(`Same hypothesis, files and baseline as ${other.id} ("${other.name}").`);
      }
    }

    const at = this.now();
    const sessions: IExperiment["sessions"][number][] = [];
    for (const id of input.baselineSessionIDs ?? []) {
      const lead = await this.deps.groups.leadOf(id);
      if (lead === undefined) throw new ExperimentError(`Unknown session: ${id}`);
      if (!sessions.some((s) => s.sessionID === lead)) sessions.push({ sessionID: lead, role: EExperimentRole.Baseline, addedAt: at });
    }

    const experiment: IExperiment = {
      version: EVALUATION_SCHEMA_VERSION,
      id: this.newId(),
      name,
      hypothesis,
      targetFiles: targets,
      criteria: { ...(taskCategory !== "" && { taskCategory }), ...(description !== "" && { description }) },
      status: EExperimentStatus.AwaitingCandidate,
      createdAt: at,
      updatedAt: at,
      baseline: { revisionId: snapshot.id, targetRevisionId, capturedAt: at },
      ...(input.origin && { origin: input.origin }),
      sessions,
      evaluations: [],
      history: [{ at, kind: "created", detail: `baseline ${snapshot.id}` }],
    };
    await this.store.putExperiment(experiment);
    return experiment;
  }

  /** Whether the context now differs from the baseline in the target files, without recording anything on the experiment. */
  async detectCandidate(id: string): Promise<ICandidateDetection> {
    const experiment = await this.open(id);
    const current = await this.deps.snapshotter.current();
    await this.store.putSnapshot(current);
    const baseline = await this.store.getSnapshot(experiment.baseline.revisionId);
    if (!baseline) throw new ExperimentError("The baseline snapshot is missing or damaged, so changes cannot be compared.");
    const targets = new Set(experiment.targetFiles);
    const diff = diffSnapshots(baseline, current);
    const targetChanges = restrictDiff(diff, targets);
    return {
      changed: !isEmptyDiff(targetChanges),
      revisionId: current.id,
      targetRevisionId: scopedRevisionId(current.files, experiment.targetFiles),
      targetChanges,
      otherChanges: diffPaths(excludeDiff(diff, targets)),
      alreadyConfirmed: experiment.candidate?.revisionId === current.id,
    };
  }

  /**
   * Links `revisionId` as the candidate. It must be a revision the plugin has a snapshot of, and it must
   * differ from the baseline in the target files: a later revision that never touched them is not a candidate.
   */
  confirmCandidate(id: string, revisionId: string): Promise<IExperiment> {
    return this.mutate(id, "candidate-confirmed", async (experiment) => {
      if (revisionId === experiment.baseline.revisionId) throw new ExperimentError("That is the baseline revision.");
      const [baseline, candidate] = await Promise.all([
        this.store.getSnapshot(experiment.baseline.revisionId),
        this.store.getSnapshot(revisionId),
      ]);
      if (!baseline) throw new ExperimentError("The baseline snapshot is missing or damaged.");
      if (!candidate) throw new ExperimentError(`Unknown revision: ${revisionId}`);
      const changed = restrictDiff(diffSnapshots(baseline, candidate), new Set(experiment.targetFiles));
      if (isEmptyDiff(changed)) throw new ExperimentError("The target files are identical to the baseline in that revision.");
      return {
        patch: {
          status: EExperimentStatus.Measuring,
          candidate: {
            revisionId,
            targetRevisionId: scopedRevisionId(candidate.files, experiment.targetFiles),
            capturedAt: this.now(),
          },
        },
        detail: `candidate ${revisionId}`,
      };
    });
  }

  /**
   * Lead sessions with their revision classification and how well each fits the experiment. A session fits a
   * role only when its whole context matches that anchor revision; one that matches only the target files is
   * flagged, because other documentation differed.
   */
  async offers(id: string): Promise<ISessionOffer[]> {
    const experiment = await this.get(id);
    const selected = new Map(experiment.sessions.map((s) => [s.sessionID, s.role]));
    const offers: ISessionOffer[] = [];
    for (const lead of await this.deps.groups.leads()) {
      const [revision, descendants] = await Promise.all([this.deps.groups.revision(lead), this.deps.groups.descendantCount(lead)]);
      const fit = await this.fitOf(experiment, revision.state, revision.startRevisionId);
      offers.push({
        sessionID: lead,
        revisionState: revision.state,
        fit,
        descendants,
        ...(selected.has(lead) && { selectedRole: selected.get(lead)! }),
        ...(revision.firstSeenAt !== undefined && { firstSeenAt: revision.firstSeenAt }),
      });
    }
    return offers;
  }

  /** How a stable start revision relates to the experiment's anchors. */
  async fitOf(experiment: IExperiment, state: ERevisionState, startRevisionId: string | undefined): Promise<ESessionFit> {
    if (state === ERevisionState.Unknown) return ESessionFit.Unknown;
    if (state === ERevisionState.Mixed || startRevisionId === undefined) return ESessionFit.Mixed;
    if (startRevisionId === experiment.baseline.revisionId) return ESessionFit.Baseline;
    if (experiment.candidate?.revisionId === startRevisionId) return ESessionFit.Candidate;
    const snapshot = await this.store.getSnapshot(startRevisionId);
    if (snapshot) {
      const target = scopedRevisionId(snapshot.files, experiment.targetFiles);
      if (target === experiment.baseline.targetRevisionId || target === experiment.candidate?.targetRevisionId) return ESessionFit.OtherContextDiffers;
    }
    return ESessionFit.Other;
  }

  /** Adds or removes selected sessions. A subagent resolves to its lead; a session holds one role. */
  setSessions(id: string, change: ISessionChange): Promise<IExperiment> {
    return this.mutate(id, "sessions-changed", async (experiment) => {
      let sessions = [...experiment.sessions];
      for (const sessionID of change.remove ?? []) {
        const lead = (await this.deps.groups.leadOf(sessionID)) ?? sessionID;
        sessions = sessions.filter((s) => s.sessionID !== lead);
      }
      const at = this.now();
      for (const { sessionID, role } of change.add ?? []) {
        if (role === EExperimentRole.Candidate && !experiment.candidate) {
          throw new ExperimentError("Confirm the candidate revision before adding candidate sessions.");
        }
        const lead = await this.deps.groups.leadOf(sessionID);
        if (lead === undefined) throw new ExperimentError(`Unknown session: ${sessionID}`);
        const existing = sessions.find((s) => s.sessionID === lead);
        sessions = existing
          ? sessions.map((s) => (s === existing ? { ...s, role } : s))
          : [...sessions, { sessionID: lead, role, addedAt: at }];
      }
      return { patch: { sessions }, detail: `${sessions.length} selected` };
    });
  }

  /** Records, replaces or clears a human outcome label for a selected session. */
  label(id: string, sessionID: string, input: ILabelInput): Promise<IExperiment> {
    return this.mutate(id, "labeled", async (experiment) => {
      const lead = (await this.deps.groups.leadOf(sessionID)) ?? sessionID;
      const target = experiment.sessions.find((s) => s.sessionID === lead);
      if (!target) throw new ExperimentError("That session is not selected in this experiment.");
      const { outcome: _previous, ...rest } = target;
      let next: IExperiment["sessions"][number] = rest;
      if (!input.clear) {
        const note = collapse(input.note ?? "");
        const evidenceRef = collapse(input.evidenceRef ?? "");
        if (note.length > MAX_TEXT || evidenceRef.length > MAX_TEXT) throw new ExperimentError(`Notes and references are limited to ${MAX_TEXT} characters.`);
        const taskSuccess = input.taskSuccess === ETaskOutcome.Unknown ? undefined : input.taskSuccess;
        const adherence = input.adherence === EAdherence.Unknown ? undefined : input.adherence;
        if (taskSuccess === undefined && adherence === undefined && note === "" && evidenceRef === "") {
          throw new ExperimentError("Nothing to record: give an outcome, adherence, a note or a reference.");
        }
        const outcome: IOutcomeLabel = {
          ...(taskSuccess !== undefined && { taskSuccess }),
          ...(adherence !== undefined && { adherence }),
          ...(note !== "" && { note }),
          ...(evidenceRef !== "" && { evidenceRef }),
          labeledAt: this.now(),
        };
        next = { ...rest, outcome };
      }
      return { patch: { sessions: experiment.sessions.map((s) => (s === target ? next : s)) }, detail: lead };
    });
  }

  /** Stores an evaluation with the experiment so it can be inspected later; the oldest are dropped. */
  recordEvaluation(id: string, result: IEvaluationResult): Promise<IExperiment> {
    return this.mutate(
      id,
      "evaluated",
      (experiment) => ({
        patch: { evaluations: [...experiment.evaluations, result].slice(-MAX_EVALUATIONS) },
        detail: `${result.verdict.verdict}`,
      }),
      { allowClosed: true },
    );
  }

  close(id: string, reason?: string): Promise<IExperiment> {
    return this.mutate(id, "closed", (experiment) => {
      const text = collapse(reason ?? "");
      if (text.length > MAX_TEXT) throw new ExperimentError(`The reason is limited to ${MAX_TEXT} characters.`);
      return { patch: { status: EExperimentStatus.Closed, ...(text !== "" && { closedReason: text }) }, detail: text || undefined };
    });
  }

  private normalizeTarget(file: string): string {
    // Accept Windows separators on any platform; path.resolve only treats `\` as one on win32.
    const match = this.deps.matcher.match(toPosix(file));
    if (!match) throw new ExperimentError(`${file} is not a context file of this project.`);
    return match.relPath;
  }

  private async open(id: string): Promise<IExperiment> {
    const experiment = await this.get(id);
    if (experiment.status === EExperimentStatus.Closed) throw new ExperimentError("The experiment is closed.");
    return experiment;
  }

  /** Read-modify-write under a per-experiment lock; the patch is merged and the change logged. */
  private mutate(
    id: string,
    kind: ExperimentEventKind,
    change: (experiment: IExperiment) => { patch: Partial<IExperiment>; detail?: string | undefined } | Promise<{ patch: Partial<IExperiment>; detail?: string | undefined }>,
    options: { allowClosed?: boolean } = {},
  ): Promise<IExperiment> {
    const previous = this.locks.get(id) ?? Promise.resolve();
    const run = previous.catch(() => {}).then(async () => {
      const experiment = options.allowClosed ? await this.get(id) : await this.open(id);
      const { patch, detail } = await change(experiment);
      const at = this.now();
      const updated: IExperiment = {
        ...experiment,
        ...patch,
        updatedAt: at,
        history: [...experiment.history, { at, kind, ...(detail !== undefined && { detail }) }].slice(-MAX_HISTORY),
      };
      await this.store.putExperiment(updated);
      return updated;
    });
    this.locks.set(id, run);
    return run;
  }
}
