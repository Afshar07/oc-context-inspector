/**
 * Types of the evaluation layer (context revisions, experiments, comparisons). Everything here is
 * metadata: paths, hashes, counts, timestamps and labels the user typed. Never file contents, prompts
 * or shell-command text. Enum values are the persisted/RPC form.
 */

/** Version written into every persisted evaluation file. Readers ignore files with another version. */
export const EVALUATION_SCHEMA_VERSION = 1 as const;

/** One tracked context file at a point in time. */
export interface IFileHash {
  /** Project-relative POSIX path. */
  readonly path: string;
  /** SHA-256 (hex) of the file bytes. The bytes themselves are never stored. */
  readonly sha256: string;
  readonly sizeBytes: number;
}

/** The tracked context files at one moment. `id` is derived from `files` alone (see `revisionId`). */
export interface IRevisionSnapshot {
  readonly version: typeof EVALUATION_SCHEMA_VERSION;
  readonly id: string;
  readonly createdAt: string;
  /** Sorted by path. */
  readonly files: readonly IFileHash[];
}

/** Difference between two snapshots, by path. A rename is a removed and an added path with identical content. */
export interface IRevisionDiff {
  readonly added: readonly string[];
  readonly removed: readonly string[];
  readonly modified: readonly string[];
  readonly renamed: readonly { readonly from: string; readonly to: string }[];
}

/** How a session's context revision is known. */
export enum ERevisionState {
  /** One known revision for the whole observed run. */
  Stable = "stable",
  /** The context changed while the session (or one of its subagents) ran. */
  Mixed = "mixed",
  /** Not established: no data, or the session was first seen after it had already started. */
  Unknown = "unknown",
}

/** Which lifecycle point established the start revision of a session. */
export enum ERevisionCapture {
  /** The `prompt` hook: before the agent loop starts. */
  Prompt = "prompt",
  /** The first model request, seen with no assistant turn in its messages. */
  FirstRequest = "first-request",
  /** First seen with prior assistant turns or a tool call: the start revision is not known. */
  Late = "late",
}

/** A revision seen while the session ran. */
export interface IObservedRevision {
  readonly at: string;
  readonly revisionId: string;
}

/** `<dataDir>/evaluation/sessions/<id>.json`. One file per session, so concurrent sessions never share a writer. */
export interface ISessionRevisionRecord {
  readonly version: typeof EVALUATION_SCHEMA_VERSION;
  readonly sessionID: string;
  readonly capture: ERevisionCapture;
  readonly firstSeenAt: string;
  /** Absent when `capture` is `Late`. */
  readonly startRevisionId?: string;
  /** Distinct consecutive revisions seen; the first is the one seen first. More than one means the context changed. */
  readonly observed: readonly IObservedRevision[];
  /** `provider/model[#variant]` values seen on model requests. */
  readonly models: readonly string[];
  readonly agents: readonly string[];
  /** Hash of the plugin options that shape what is tracked (context paths, tools, auto-loaded files). */
  readonly environment?: string;
}

/** A session's revision as classified from its record. */
export interface ISessionRevision {
  readonly sessionID: string;
  readonly state: ERevisionState;
  /** Why the state is `Unknown` or `Mixed`. */
  readonly reason?: string;
  readonly startRevisionId?: string;
  /** Every distinct revision seen, in order. */
  readonly revisionIds: readonly string[];
}

export enum EExperimentStatus {
  /** Baseline captured; the documentation change has not been confirmed yet. */
  AwaitingCandidate = "awaiting-candidate",
  /** A candidate revision is confirmed; later sessions can be compared against the baseline. */
  Measuring = "measuring",
  Closed = "closed",
}

export enum EExperimentRole {
  Baseline = "baseline",
  Candidate = "candidate",
}

/** A revision an experiment is anchored to: the whole-context id and the id of the target files alone. */
export interface IExperimentRevisionRef {
  readonly revisionId: string;
  readonly targetRevisionId: string;
  readonly capturedAt: string;
}

export interface IExperimentCriteria {
  /** Free text such as "bug fix in the API layer". Descriptive: tasks are not classified automatically. */
  readonly taskCategory?: string;
  readonly description?: string;
}

export enum ETaskOutcome {
  Success = "success",
  Failure = "failure",
  Unknown = "unknown",
}

export enum EAdherence {
  Followed = "followed",
  NotFollowed = "not-followed",
  Unknown = "unknown",
}

/** A human judgment about one session. Counted in rates only when grounded (see `isGrounded`). */
export interface IOutcomeLabel {
  readonly taskSuccess?: ETaskOutcome;
  readonly adherence?: EAdherence;
  /** Short explanation typed by the user. */
  readonly note?: string;
  /** Pointer to evidence, e.g. a CI run or PR link. */
  readonly evidenceRef?: string;
  readonly labeledAt: string;
}

/** A session the user put into an experiment. Always a lead session; its subagents are grouped under it. */
export interface IExperimentSession {
  readonly sessionID: string;
  readonly role: EExperimentRole;
  readonly addedAt: string;
  readonly outcome?: IOutcomeLabel;
}

export type ExperimentEventKind = "created" | "candidate-confirmed" | "sessions-changed" | "labeled" | "evaluated" | "closed";

export interface IExperimentEvent {
  readonly at: string;
  readonly kind: ExperimentEventKind;
  readonly detail?: string;
}

export type ExperimentOriginKind = "session-analysis" | "project-review" | "manual";

export interface IExperimentOrigin {
  readonly kind: ExperimentOriginKind;
  readonly sessionID?: string;
}

export interface IExperiment {
  readonly version: typeof EVALUATION_SCHEMA_VERSION;
  readonly id: string;
  readonly name: string;
  readonly hypothesis: string;
  /** Project-relative POSIX paths of the context files the experiment is about. May include files that do not exist yet. */
  readonly targetFiles: readonly string[];
  readonly criteria: IExperimentCriteria;
  readonly status: EExperimentStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly baseline: IExperimentRevisionRef;
  readonly candidate?: IExperimentRevisionRef;
  readonly origin?: IExperimentOrigin;
  readonly sessions: readonly IExperimentSession[];
  /** Most recent last; capped. */
  readonly evaluations: readonly IEvaluationResult[];
  readonly history: readonly IExperimentEvent[];
  readonly closedReason?: string;
}

/** Why a selected session is not part of a comparison. */
export enum EExclusionReason {
  SessionNotFound = "session-not-found",
  UnknownRevision = "unknown-revision",
  MixedRevision = "mixed-revision",
  RevisionMismatch = "revision-mismatch",
  /** The target files match but other context files differ from the experiment's anchor revision. */
  OtherContextDiffers = "other-context-differs",
  NoCandidate = "no-candidate-revision",
  /** The session's read records could not be read. Not the same as a session with no reads. */
  RecordsUnreadable = "records-unreadable",
}

export interface IExclusion {
  readonly sessionID: string;
  readonly role: EExperimentRole;
  readonly reason: EExclusionReason;
  readonly detail?: string;
}

/** How well a session fits an experiment role by revision alone. */
export enum ESessionFit {
  Baseline = "baseline",
  Candidate = "candidate",
  OtherContextDiffers = "other-context-differs",
  Other = "other",
  Mixed = "mixed",
  Unknown = "unknown",
}

/** One lead session offered for selection, with its revision classification. */
export interface ISessionOffer {
  readonly sessionID: string;
  readonly revisionState: ERevisionState;
  readonly fit: ESessionFit;
  /** Number of sessions below it (subagents), which are grouped with it. */
  readonly descendants: number;
  readonly selectedRole?: EExperimentRole;
  readonly firstSeenAt?: string;
}

/** What the TUI sends per lead session: counts derived from OpenCode's message log. Never command text. */
export interface ISessionActivity {
  /** The lead session. */
  readonly sessionID: string;
  /** Every session of the group loaded; false means the counts may be short. */
  readonly complete: boolean;
  readonly unavailableSessions: number;
  /** First file-changing tool call of the group; absent when none, or when the group's steps are unavailable. */
  readonly firstActionAt?: string;
  readonly actionCount: number;
  readonly shellRuns: number;
  readonly shellWithExit: number;
  readonly shellNonZero: number;
  /** Shell runs whose command looks like a test, type-check, lint or build run. A name match, not a result. */
  readonly verificationRuns: number;
  readonly verificationWithExit: number;
  readonly verificationNonZero: number;
}

export enum ECompleteness {
  Full = "full",
  Partial = "partial",
  Unknown = "unknown",
}

/** Why a per-group value is missing. */
export enum EMissing {
  /** The TUI could not provide the group's steps. */
  NoTimeline = "no-timeline",
  /** The group made no file-changing call, so "before an action" has no meaning. */
  NoAction = "no-action",
  /** The group never read a target file explicitly. */
  NoRead = "no-read",
  /** Every target file is injected by OpenCode and invisible to the hooks. */
  AutoLoadedOnly = "auto-loaded-only",
  NoDelivery = "no-delivery-info",
}

/** What was measured for one lead session and its subagents. The reproducible unit of an evaluation. */
export interface IGroupMeasurement {
  readonly sessionID: string;
  readonly role: EExperimentRole;
  /** The lead and its descendants. */
  readonly memberSessionIDs: readonly string[];
  readonly revisionState: ERevisionState;
  readonly explicitTargetRead: boolean;
  readonly targetFilesRead: readonly string[];
  /** Target files OpenCode injects itself: not counted as unread. */
  readonly autoLoadedTargets: readonly string[];
  /** Whether the first explicit target read preceded the first file-changing call. Absent: see `readBeforeActionMissing`. */
  readonly readBeforeAction?: boolean;
  readonly readBeforeActionMissing?: EMissing;
  readonly completeness?: ECompleteness;
  readonly completenessMissing?: EMissing;
  /** Target-file reads of the same agent that overlapped lines it already had. */
  readonly repeatReads: number;
  /** Target-file reads of lines another agent of the group already had. */
  readonly crossAgentRereads: number;
  readonly failedReads: number;
  /** Lines the tool returned for target reads, and lines requested by reads with an explicit `limit` (reads with both). */
  readonly deliveredLines: number;
  readonly requestedLines: number;
  /** Successful plus failed reads of any context file, by the group. */
  readonly contextReads: number;
  readonly activity?: ISessionActivity;
  readonly models: readonly string[];
  readonly environments: readonly string[];
  readonly outcome?: IOutcomeLabel;
}

export enum EVerdict {
  Improved = "improved",
  Regressed = "regressed",
  Unchanged = "unchanged",
  Inconclusive = "inconclusive",
}

export enum EMetricKind {
  /** Counted from recorded evidence. */
  Observed = "observed",
  /** Computed from outcome labels a human entered. */
  Labeled = "labeled",
}

export enum EMetricUnit {
  /** A proportion 0..1. Changes are percentage points. */
  Rate = "rate",
  /** Mean per lead session. */
  Mean = "mean",
  /** Total delivered divided by total requested. */
  Ratio = "ratio",
}

export type MetricGroup = "discovery" | "efficiency" | "verification" | "outcome";

/** One side (baseline or candidate) of a metric. */
export interface IMetricSide {
  /** Lead sessions that contribute a value. */
  readonly n: number;
  /** Lead sessions in this side's population that cannot contribute. */
  readonly missing: number;
  readonly value?: number;
  readonly numerator?: number;
  readonly denominator?: number;
}

export interface IMetricComparison {
  readonly id: string;
  readonly label: string;
  readonly group: MetricGroup;
  readonly kind: EMetricKind;
  readonly unit: EMetricUnit;
  /** Whether a verdict is defensible for this metric. Signals are shown but get no verdict. */
  readonly directional: boolean;
  readonly baseline: IMetricSide;
  readonly candidate: IMetricSide;
  /** candidate - baseline. A fraction for rates (percentage points when shown). */
  readonly absoluteChange?: number;
  /** (candidate - baseline) / baseline; absent when the baseline is 0 or missing. */
  readonly relativeChange?: number;
  /** Absent for signals. */
  readonly verdict?: EVerdict;
  readonly notes: readonly string[];
}

/** Context in which the two samples ran. Differences are surfaced as limitations, never hidden. */
export interface IComparisonContext {
  readonly baselineModels: readonly string[];
  readonly candidateModels: readonly string[];
  readonly baselineEnvironments: readonly string[];
  readonly candidateEnvironments: readonly string[];
  /**
   * Models of both sides are known and the same set (true), known and different (false). Undefined when any
   * session of either side has no model recorded: unknown is not comparable, and blocks directional verdicts.
   */
  readonly modelsComparable?: boolean;
  /** Same, for the plugin tracking configuration. */
  readonly environmentsComparable?: boolean;
  /** Anchor revisions whose snapshot is missing or damaged. Absent (older results) or empty: both were readable. */
  readonly missingAnchors?: readonly EExperimentRole[];
  /** Context files outside the targets that differ between the two anchor revisions. */
  readonly nonTargetChanges: readonly string[];
  /** Target files that changed between the anchor revisions. */
  readonly targetChanges: IRevisionDiff;
}

export interface IOverallVerdict {
  /**
   * Task effectiveness: decided only by grounded human outcome labels (task success, instruction adherence).
   * Inconclusive when those labels are too few, even if discovery moved. Results stored before `discovery`
   * existed carry a verdict that mixed both.
   */
  readonly verdict: EVerdict;
  /** Context discovery: whether agents read the target files more, earlier or more completely. Not task quality. */
  readonly discovery?: EVerdict;
  /** Ids of directional metrics that improved/regressed (discovery and outcome). */
  readonly improved: readonly string[];
  readonly regressed: readonly string[];
  readonly reasons: readonly string[];
}

export interface IEvaluationSettings {
  /** Fewest lead sessions per side before a metric can get a verdict. */
  readonly minSamples: number;
  /** Rate change (fraction) at which a difference counts as real; below half of it counts as none. */
  readonly rateThreshold: number;
}

/** A reproducible evaluation: re-running the comparison on `groups` with `settings` gives `metrics` and `verdict`. */
export interface IEvaluationResult {
  readonly version: typeof EVALUATION_SCHEMA_VERSION;
  readonly experimentId: string;
  readonly evaluatedAt: string;
  readonly settings: IEvaluationSettings;
  readonly baselineRevisionId: string;
  readonly candidateRevisionId?: string;
  readonly groups: readonly IGroupMeasurement[];
  readonly exclusions: readonly IExclusion[];
  readonly metrics: readonly IMetricComparison[];
  readonly context: IComparisonContext;
  readonly verdict: IOverallVerdict;
  /** Plain statements of what the evidence cannot show. */
  readonly limitations: readonly string[];
}
