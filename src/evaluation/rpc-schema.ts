import { Schema } from "effect";
import {
  EAdherence,
  ECompleteness,
  EExclusionReason,
  EExperimentRole,
  EExperimentStatus,
  EMetricKind,
  EMetricUnit,
  EMissing,
  ERevisionState,
  ESessionFit,
  ETaskOutcome,
  EVerdict,
  type IEvaluationResult,
  type IExperiment,
  type ISessionActivity,
  type ISessionOffer,
} from "./types.js";
import type { IGroupRevision } from "./groups.js";
import type { ICandidateDetection } from "./experiments.js";

/** Wire schemas of the evaluation RPC methods. Shapes mirror `types.ts`; the guards below keep them in step. */

const optional = Schema.optionalKey;
const Version = Schema.Literal(1);

export const SessionActivity = Schema.Struct({
  sessionID: Schema.String,
  complete: Schema.Boolean,
  unavailableSessions: Schema.Number,
  firstActionAt: optional(Schema.String),
  actionCount: Schema.Number,
  shellRuns: Schema.Number,
  shellWithExit: Schema.Number,
  shellNonZero: Schema.Number,
  verificationRuns: Schema.Number,
  verificationWithExit: Schema.Number,
  verificationNonZero: Schema.Number,
});

const OutcomeLabel = Schema.Struct({
  taskSuccess: optional(Schema.Enum(ETaskOutcome)),
  adherence: optional(Schema.Enum(EAdherence)),
  note: optional(Schema.String),
  evidenceRef: optional(Schema.String),
  labeledAt: Schema.String,
});

const GroupMeasurement = Schema.Struct({
  sessionID: Schema.String,
  role: Schema.Enum(EExperimentRole),
  memberSessionIDs: Schema.Array(Schema.String),
  revisionState: Schema.Enum(ERevisionState),
  explicitTargetRead: Schema.Boolean,
  targetFilesRead: Schema.Array(Schema.String),
  autoLoadedTargets: Schema.Array(Schema.String),
  readBeforeAction: optional(Schema.Boolean),
  readBeforeActionMissing: optional(Schema.Enum(EMissing)),
  completeness: optional(Schema.Enum(ECompleteness)),
  completenessMissing: optional(Schema.Enum(EMissing)),
  repeatReads: Schema.Number,
  crossAgentRereads: Schema.Number,
  failedReads: Schema.Number,
  deliveredLines: Schema.Number,
  requestedLines: Schema.Number,
  contextReads: Schema.Number,
  activity: optional(SessionActivity),
  models: Schema.Array(Schema.String),
  environments: Schema.Array(Schema.String),
  outcome: optional(OutcomeLabel),
});

const MetricSide = Schema.Struct({
  n: Schema.Number,
  missing: Schema.Number,
  value: optional(Schema.Number),
  numerator: optional(Schema.Number),
  denominator: optional(Schema.Number),
});

const MetricComparison = Schema.Struct({
  id: Schema.String,
  label: Schema.String,
  group: Schema.Literals(["discovery", "efficiency", "verification", "outcome"]),
  kind: Schema.Enum(EMetricKind),
  unit: Schema.Enum(EMetricUnit),
  directional: Schema.Boolean,
  baseline: MetricSide,
  candidate: MetricSide,
  absoluteChange: optional(Schema.Number),
  relativeChange: optional(Schema.Number),
  verdict: optional(Schema.Enum(EVerdict)),
  notes: Schema.Array(Schema.String),
});

const RevisionDiff = Schema.Struct({
  added: Schema.Array(Schema.String),
  removed: Schema.Array(Schema.String),
  modified: Schema.Array(Schema.String),
  renamed: Schema.Array(Schema.Struct({ from: Schema.String, to: Schema.String })),
});

const ComparisonContext = Schema.Struct({
  baselineModels: Schema.Array(Schema.String),
  candidateModels: Schema.Array(Schema.String),
  baselineEnvironments: Schema.Array(Schema.String),
  candidateEnvironments: Schema.Array(Schema.String),
  modelsComparable: optional(Schema.Boolean),
  environmentsComparable: optional(Schema.Boolean),
  missingAnchors: optional(Schema.Array(Schema.Enum(EExperimentRole))),
  nonTargetChanges: Schema.Array(Schema.String),
  targetChanges: RevisionDiff,
});

export const EvaluationResult = Schema.Struct({
  version: Version,
  experimentId: Schema.String,
  evaluatedAt: Schema.String,
  settings: Schema.Struct({ minSamples: Schema.Number, rateThreshold: Schema.Number }),
  baselineRevisionId: Schema.String,
  candidateRevisionId: optional(Schema.String),
  groups: Schema.Array(GroupMeasurement),
  exclusions: Schema.Array(
    Schema.Struct({
      sessionID: Schema.String,
      role: Schema.Enum(EExperimentRole),
      reason: Schema.Enum(EExclusionReason),
      detail: optional(Schema.String),
    }),
  ),
  metrics: Schema.Array(MetricComparison),
  context: ComparisonContext,
  verdict: Schema.Struct({
    verdict: Schema.Enum(EVerdict),
    discovery: optional(Schema.Enum(EVerdict)),
    improved: Schema.Array(Schema.String),
    regressed: Schema.Array(Schema.String),
    reasons: Schema.Array(Schema.String),
  }),
  limitations: Schema.Array(Schema.String),
});

const RevisionRef = Schema.Struct({ revisionId: Schema.String, targetRevisionId: Schema.String, capturedAt: Schema.String });

export const Experiment = Schema.Struct({
  version: Version,
  id: Schema.String,
  name: Schema.String,
  hypothesis: Schema.String,
  targetFiles: Schema.Array(Schema.String),
  criteria: Schema.Struct({ taskCategory: optional(Schema.String), description: optional(Schema.String) }),
  status: Schema.Enum(EExperimentStatus),
  createdAt: Schema.String,
  updatedAt: Schema.String,
  baseline: RevisionRef,
  candidate: optional(RevisionRef),
  origin: optional(
    Schema.Struct({
      kind: Schema.Literals(["session-analysis", "project-review", "manual"]),
      sessionID: optional(Schema.String),
    }),
  ),
  sessions: Schema.Array(
    Schema.Struct({
      sessionID: Schema.String,
      role: Schema.Enum(EExperimentRole),
      addedAt: Schema.String,
      outcome: optional(OutcomeLabel),
    }),
  ),
  evaluations: Schema.Array(EvaluationResult),
  history: Schema.Array(
    Schema.Struct({
      at: Schema.String,
      kind: Schema.Literals(["created", "candidate-confirmed", "sessions-changed", "labeled", "evaluated", "closed"]),
      detail: optional(Schema.String),
    }),
  ),
  closedReason: optional(Schema.String),
});

export const SessionOffer = Schema.Struct({
  sessionID: Schema.String,
  revisionState: Schema.Enum(ERevisionState),
  fit: Schema.Enum(ESessionFit),
  descendants: Schema.Number,
  selectedRole: optional(Schema.Enum(EExperimentRole)),
  firstSeenAt: optional(Schema.String),
});

export const GroupRevision = Schema.Struct({
  sessionID: Schema.String,
  leadSessionID: Schema.String,
  members: Schema.Array(Schema.String),
  state: Schema.Enum(ERevisionState),
  reason: optional(Schema.String),
  startRevisionId: optional(Schema.String),
  revisionIds: Schema.Array(Schema.String),
  models: Schema.Array(Schema.String),
  environments: Schema.Array(Schema.String),
  firstSeenAt: optional(Schema.String),
});

export const CandidateDetection = Schema.Struct({
  changed: Schema.Boolean,
  revisionId: Schema.String,
  targetRevisionId: Schema.String,
  targetChanges: RevisionDiff,
  otherChanges: Schema.Array(Schema.String),
  alreadyConfirmed: Schema.Boolean,
});

// Compile-time guard that the wire schemas and the domain types stay in step.
const sameShape = <A, B extends A>(_: (a: A) => B) => {};
sameShape<IExperiment, (typeof Experiment)["Type"]>((a) => a);
sameShape<(typeof Experiment)["Type"], IExperiment>((a) => a);
sameShape<IEvaluationResult, (typeof EvaluationResult)["Type"]>((a) => a);
sameShape<(typeof EvaluationResult)["Type"], IEvaluationResult>((a) => a);
sameShape<ISessionOffer, (typeof SessionOffer)["Type"]>((a) => a);
sameShape<(typeof SessionOffer)["Type"], ISessionOffer>((a) => a);
sameShape<ISessionActivity, (typeof SessionActivity)["Type"]>((a) => a);
sameShape<(typeof SessionActivity)["Type"], ISessionActivity>((a) => a);
sameShape<IGroupRevision, (typeof GroupRevision)["Type"]>((a) => a);
sameShape<(typeof GroupRevision)["Type"], IGroupRevision>((a) => a);
sameShape<ICandidateDetection, (typeof CandidateDetection)["Type"]>((a) => a);
sameShape<(typeof CandidateDetection)["Type"], ICandidateDetection>((a) => a);
