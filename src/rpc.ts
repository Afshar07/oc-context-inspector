import { Rpc } from "@opencode/plugin/rpc";
import { Schema } from "effect";
import {
  CandidateDetection,
  EvaluationResult,
  Experiment,
  GroupRevision,
  SessionActivity,
  SessionOffer,
} from "./evaluation/rpc-schema.js";
import { EAdherence, EExperimentRole, ETaskOutcome } from "./evaluation/types.js";
import {
  EAgentRole,
  ECoverageCertainty,
  ECoverageStatus,
  ESessionTracking,
  ETimelineKind,
  ETimelineSessionState,
  type ICoverageReport,
  type IFilePreview,
  type ITimelineEvent,
  type ITimelineSessionInfo,
} from "./types.js";

/** RPC methods/events need Standard Schema on both ends; Effect schemas provide it. */
const portable = <S extends Schema.ConstraintDecoder<unknown>>(schema: S) => Schema.toStandardSchemaV1(schema);

const LineRange = Schema.Struct({ start: Schema.Number, end: Schema.Number });

const AgentReadSummary = Schema.Struct({
  sessionID: Schema.String,
  agentID: Schema.optionalKey(Schema.String),
  role: Schema.Enum(EAgentRole),
  parentSessionID: Schema.optionalKey(Schema.String),
  depth: Schema.Number,
  readCount: Schema.Number,
  errorCount: Schema.Number,
  repeatReads: Schema.Number,
  handoffRereads: Schema.Number,
  ranges: Schema.Array(LineRange),
  lastReadAt: Schema.optionalKey(Schema.String),
});

const FileCoverage = Schema.Struct({
  filePath: Schema.String,
  status: Schema.Enum(ECoverageStatus),
  exists: Schema.Boolean,
  lineCount: Schema.Number,
  ranges: Schema.Array(LineRange),
  readCount: Schema.Number,
  errorCount: Schema.Number,
  lastReadAt: Schema.optionalKey(Schema.String),
  modifiedSinceRead: Schema.Boolean,
  certainty: Schema.Enum(ECoverageCertainty),
  lineCountAtRead: Schema.optionalKey(Schema.Number),
  agents: Schema.Array(AgentReadSummary),
  repeatReads: Schema.Number,
  handoffRereads: Schema.Number,
});

const CoverageReport = Schema.Struct({
  sessionID: Schema.String,
  tracking: Schema.Enum(ESessionTracking),
  files: Schema.Array(FileCoverage),
});

const FilePreview = Schema.Struct({
  coverage: FileCoverage,
  lines: Schema.Array(Schema.String),
  truncated: Schema.Boolean,
  contentMayDiffer: Schema.Boolean,
});

const TimelineEvent = Schema.Struct({
  at: Schema.String,
  sessionID: Schema.String,
  agentID: Schema.optionalKey(Schema.String),
  kind: Schema.Enum(ETimelineKind),
  tool: Schema.optionalKey(Schema.String),
  status: Schema.optionalKey(Schema.Literals(["completed", "error"])),
  path: Schema.optionalKey(Schema.String),
  callID: Schema.optionalKey(Schema.String),
  text: Schema.optionalKey(Schema.String),
  command: Schema.optionalKey(Schema.String),
  exit: Schema.optionalKey(Schema.Number),
});

const TimelineSession = Schema.Struct({
  sessionID: Schema.String,
  parentID: Schema.optionalKey(Schema.String),
  agentID: Schema.optionalKey(Schema.String),
  depth: Schema.Number,
  state: Schema.Enum(ETimelineSessionState),
  messages: Schema.Number,
  reason: Schema.optionalKey(Schema.String),
});

const Failure = Schema.Struct({ ok: Schema.Literal(false), error: Schema.String });

// Compile-time guard that the wire schemas and the domain types stay in step.
const sameShape = <A, B extends A>(_: (a: A) => B) => {};
sameShape<ICoverageReport, (typeof CoverageReport)["Type"]>((a) => a);
sameShape<(typeof CoverageReport)["Type"], ICoverageReport>((a) => a);
sameShape<IFilePreview, (typeof FilePreview)["Type"]>((a) => a);
sameShape<(typeof FilePreview)["Type"], IFilePreview>((a) => a);
sameShape<ITimelineEvent, (typeof TimelineEvent)["Type"]>((a) => a);
sameShape<(typeof TimelineEvent)["Type"], ITimelineEvent>((a) => a);
sameShape<ITimelineSessionInfo, (typeof TimelineSession)["Type"]>((a) => a);
sameShape<(typeof TimelineSession)["Type"], ITimelineSessionInfo>((a) => a);

const ExperimentOk = Schema.Struct({ ok: Schema.Literal(true), experiment: Experiment });
const ExperimentReply = Schema.Union([ExperimentOk, Failure]);
const SessionRole = Schema.Struct({ sessionID: Schema.String, role: Schema.Enum(EExperimentRole) });

/** Shared by the server entry (registers handlers) and the TUI entry (calls them). */
export const ContextInspectorRpc = Rpc.define({
  id: "context-inspector",
  methods: {
    coverage: {
      input: portable(Schema.Struct({ sessionID: Schema.String })),
      output: portable(CoverageReport),
    },
    /** Model review of one session's reads; `task` is the user's messages, for relevance. */
    analyzeSession: {
      // `model`: `provider/model[#variant]` picked in the TUI; the configured or default model when absent.
      input: portable(
        Schema.Struct({
          sessionID: Schema.String,
          task: Schema.Array(Schema.String),
          model: Schema.optionalKey(Schema.String),
          // Steps of the session and its subagents, built by the TUI; absent from older TUIs.
          timeline: Schema.optionalKey(Schema.Struct({
              events: Schema.Array(TimelineEvent),
              omitted: Schema.Number,
              sessions: Schema.optionalKey(Schema.Array(TimelineSession)),
            })),
        }),
      ),
      output: portable(
        Schema.Union([Schema.Struct({ ok: Schema.Literal(true), text: Schema.String, model: Schema.String }), Failure]),
      ),
    },
    /** Model review of how every recorded session used the project's context files. */
    reviewProject: {
      input: portable(Schema.Struct({ model: Schema.optionalKey(Schema.String) })),
      output: portable(
        Schema.Union([
          Schema.Struct({
            ok: Schema.Literal(true),
            text: Schema.String,
            sessionCount: Schema.Number,
            readsOnlySessions: Schema.Number,
            model: Schema.String,
          }),
          Failure,
        ]),
      ),
    },
    /** `found: false` when the path is not a context file of the project. */
    preview: {
      input: portable(Schema.Struct({ sessionID: Schema.String, filePath: Schema.String })),
      output: portable(
        Schema.Union([
          Schema.Struct({ found: Schema.Literal(true), preview: FilePreview }),
          Schema.Struct({ found: Schema.Literal(false) }),
        ]),
      ),
    },
    /** Context revision a session (with its subagents) ran under; `unknown` when it cannot be established. */
    sessionRevision: {
      input: portable(Schema.Struct({ sessionID: Schema.String })),
      output: portable(GroupRevision),
    },
    /** Revision of the project's context files right now. */
    currentRevision: {
      input: portable(Schema.Struct({})),
      output: portable(Schema.Struct({ revisionId: Schema.String, fileCount: Schema.Number, createdAt: Schema.String })),
    },
    listExperiments: {
      input: portable(Schema.Struct({})),
      output: portable(Schema.Struct({ experiments: Schema.Array(Experiment), unreadable: Schema.Number })),
    },
    /** Records a baseline from the current context. Edits no file and starts no agent. */
    createExperiment: {
      input: portable(
        Schema.Struct({
          name: Schema.String,
          hypothesis: Schema.String,
          targetFiles: Schema.Array(Schema.String),
          taskCategory: Schema.optionalKey(Schema.String),
          description: Schema.optionalKey(Schema.String),
          baselineSessionIDs: Schema.optionalKey(Schema.Array(Schema.String)),
          origin: Schema.optionalKey(
            Schema.Struct({
              kind: Schema.Literals(["session-analysis", "project-review", "manual"]),
              sessionID: Schema.optionalKey(Schema.String),
            }),
          ),
        }),
      ),
      output: portable(ExperimentReply),
    },
    closeExperiment: {
      input: portable(Schema.Struct({ id: Schema.String, reason: Schema.optionalKey(Schema.String) })),
      output: portable(ExperimentReply),
    },
    /** Does the current context differ from the baseline in the target files? Changes nothing. */
    detectCandidate: {
      input: portable(Schema.Struct({ id: Schema.String })),
      output: portable(Schema.Union([Schema.Struct({ ok: Schema.Literal(true), detection: CandidateDetection }), Failure])),
    },
    confirmCandidate: {
      input: portable(Schema.Struct({ id: Schema.String, revisionId: Schema.String })),
      output: portable(ExperimentReply),
    },
    /** Lead sessions with their revision and how well they fit the experiment. */
    experimentSessions: {
      input: portable(Schema.Struct({ id: Schema.String })),
      output: portable(Schema.Union([Schema.Struct({ ok: Schema.Literal(true), offers: Schema.Array(SessionOffer) }), Failure])),
    },
    setExperimentSessions: {
      input: portable(
        Schema.Struct({
          id: Schema.String,
          add: Schema.optionalKey(Schema.Array(SessionRole)),
          remove: Schema.optionalKey(Schema.Array(Schema.String)),
        }),
      ),
      output: portable(ExperimentReply),
    },
    /** A human judgment about one selected session. Stored as typed; never inferred. */
    labelSession: {
      input: portable(
        Schema.Struct({
          id: Schema.String,
          sessionID: Schema.String,
          taskSuccess: Schema.optionalKey(Schema.Enum(ETaskOutcome)),
          adherence: Schema.optionalKey(Schema.Enum(EAdherence)),
          note: Schema.optionalKey(Schema.String),
          evidenceRef: Schema.optionalKey(Schema.String),
          clear: Schema.optionalKey(Schema.Boolean),
        }),
      ),
      output: portable(ExperimentReply),
    },
    /** Compares baseline and candidate sessions. `activity` (counts from the message log) comes from the TUI; absent from older TUIs. */
    evaluateExperiment: {
      input: portable(Schema.Struct({ id: Schema.String, activity: Schema.optionalKey(Schema.Array(SessionActivity)) })),
      output: portable(Schema.Union([Schema.Struct({ ok: Schema.Literal(true), result: EvaluationResult }), Failure])),
    },
  },
  events: {
    /** A context-file read was recorded; payload is metadata only. */
    read: {
      schema: portable(
        Schema.Struct({
          sessionID: Schema.String,
          filePath: Schema.String,
          /** Sessions that spawned this one, nearest first; absent from older servers. */
          ancestors: Schema.optionalKey(Schema.Array(Schema.String)),
        }),
      ),
    },
  },
});
