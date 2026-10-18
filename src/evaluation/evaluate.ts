import { readSessionRecords } from "../store.js";
import type { IClock, IContextReadRecord } from "../types.js";
import { compareGroups, DEFAULT_SETTINGS, limitationsFor, overallVerdict, sideContext } from "./comparison.js";
import type { ExperimentService } from "./experiments.js";
import type { GroupResolver } from "./groups.js";
import { measureGroup } from "./metrics.js";
import { diffPaths, diffSnapshots, excludeDiff, restrictDiff } from "./revisions.js";
import type { EvaluationStore } from "./store.js";
import {
  EExclusionReason,
  EExperimentRole,
  ERevisionState,
  ESessionFit,
  EVALUATION_SCHEMA_VERSION,
  type IComparisonContext,
  type IEvaluationResult,
  type IEvaluationSettings,
  type IExclusion,
  type IGroupMeasurement,
  type IRevisionDiff,
  type ISessionActivity,
} from "./types.js";

const short = (revisionId: string | undefined) => (revisionId ?? "none").slice(0, 8);
const EMPTY_DIFF: IRevisionDiff = { added: [], removed: [], modified: [], renamed: [] };

export interface IEvaluationDeps {
  readonly experiments: ExperimentService;
  readonly groups: GroupResolver;
  readonly store: EvaluationStore;
  readonly dataDir: string;
  /** Project-relative files OpenCode injects itself. */
  readonly autoLoaded: readonly string[];
  readonly clock?: IClock;
  readonly settings?: IEvaluationSettings;
}

/**
 * Compares the baseline and candidate sessions of an experiment. Reads only recorded evidence plus the
 * activity summaries the TUI derived; it does not call a model, and the same inputs give the same result.
 */
export class EvaluationService {
  private readonly clock: IClock;
  private readonly settings: IEvaluationSettings;

  constructor(private readonly deps: IEvaluationDeps) {
    this.clock = deps.clock ?? { now: () => new Date() };
    this.settings = deps.settings ?? DEFAULT_SETTINGS;
  }

  /** Measures every selected session, excludes those that are not clean samples (with the reason), compares, and stores the result. */
  async evaluate(experimentId: string, activity: readonly ISessionActivity[] = []): Promise<IEvaluationResult> {
    const { experiments, groups, store, dataDir, autoLoaded } = this.deps;
    const experiment = await experiments.get(experimentId);
    const targets = new Set(experiment.targetFiles);
    const activityOf = new Map(activity.map((a) => [a.sessionID, a]));

    const exclusions: IExclusion[] = [];
    const measured: IGroupMeasurement[] = [];
    for (const selection of experiment.sessions) {
      const exclude = (reason: EExclusionReason, detail?: string) =>
        exclusions.push({ sessionID: selection.sessionID, role: selection.role, reason, ...(detail !== undefined && { detail }) });
      if ((await groups.leadOf(selection.sessionID)) === undefined) {
        exclude(EExclusionReason.SessionNotFound);
        continue;
      }
      const anchor = selection.role === EExperimentRole.Baseline ? experiment.baseline : experiment.candidate;
      if (!anchor) {
        exclude(EExclusionReason.NoCandidate, "no candidate revision is confirmed yet");
        continue;
      }
      const revision = await groups.revision(selection.sessionID);
      if (revision.state === ERevisionState.Unknown) {
        exclude(EExclusionReason.UnknownRevision, revision.reason);
        continue;
      }
      if (revision.state === ERevisionState.Mixed) {
        exclude(EExclusionReason.MixedRevision, revision.reason);
        continue;
      }
      if (revision.startRevisionId !== anchor.revisionId) {
        const fit = await experiments.fitOf(experiment, revision.state, revision.startRevisionId);
        if (fit === ESessionFit.OtherContextDiffers) {
          exclude(EExclusionReason.OtherContextDiffers, `target files match, but other context differs (${short(revision.startRevisionId)} vs ${short(anchor.revisionId)})`);
        } else {
          exclude(EExclusionReason.RevisionMismatch, `ran under ${short(revision.startRevisionId)}, expected ${short(anchor.revisionId)}`);
        }
        continue;
      }

      const records = (await Promise.all(revision.members.map((id) => readSessionRecords(dataDir, id).catch((): IContextReadRecord[] => [])))).flat();
      const sessionActivity = activityOf.get(selection.sessionID);
      measured.push(
        measureGroup({
          sessionID: selection.sessionID,
          role: selection.role,
          members: revision.members,
          records,
          targets,
          autoLoaded,
          revisionState: revision.state,
          models: revision.models,
          environments: revision.environments,
          ...(sessionActivity && { activity: sessionActivity }),
          ...(selection.outcome && { outcome: selection.outcome }),
        }),
      );
    }

    const baselineGroups = measured.filter((g) => g.role === EExperimentRole.Baseline);
    const candidateGroups = measured.filter((g) => g.role === EExperimentRole.Candidate);

    const anchors = await this.anchorChanges(experiment.baseline.revisionId, experiment.candidate?.revisionId, targets);
    const context: IComparisonContext = { ...sideContext(baselineGroups, candidateGroups), ...anchors.changes };
    const metrics = compareGroups(baselineGroups, candidateGroups, context, this.settings);
    const limitations = limitationsFor(baselineGroups, candidateGroups, context, exclusions.length, this.settings);
    if (anchors.unavailable) limitations.push("An anchor revision snapshot is missing or damaged, so changes between the revisions could not be listed.");
    if (!experiment.candidate) limitations.push("No candidate revision is confirmed, so there is nothing to compare against the baseline yet.");

    const result: IEvaluationResult = {
      version: EVALUATION_SCHEMA_VERSION,
      experimentId,
      evaluatedAt: this.clock.now().toISOString(),
      settings: this.settings,
      baselineRevisionId: experiment.baseline.revisionId,
      ...(experiment.candidate && { candidateRevisionId: experiment.candidate.revisionId }),
      groups: measured,
      exclusions,
      metrics,
      context,
      verdict: overallVerdict(metrics, context),
      limitations,
    };
    await experiments.recordEvaluation(experimentId, result);
    return result;
  }

  private async anchorChanges(baselineId: string, candidateId: string | undefined, targets: ReadonlySet<string>) {
    if (candidateId === undefined) return { unavailable: false, changes: { nonTargetChanges: [], targetChanges: EMPTY_DIFF } };
    const [baseline, candidate] = await Promise.all([this.deps.store.getSnapshot(baselineId), this.deps.store.getSnapshot(candidateId)]);
    if (!baseline || !candidate) return { unavailable: true, changes: { nonTargetChanges: [], targetChanges: EMPTY_DIFF } };
    const diff = diffSnapshots(baseline, candidate);
    return {
      unavailable: false,
      changes: { nonTargetChanges: diffPaths(excludeDiff(diff, targets)), targetChanges: restrictDiff(diff, targets) },
    };
  }
}
