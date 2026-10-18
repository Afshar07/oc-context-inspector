import { Rpc } from "@opencode/plugin/rpc";
import { Schema } from "effect";
import {
  EAgentRole,
  ECoverageCertainty,
  ECoverageStatus,
  ESessionTracking,
  ETimelineKind,
  type ICoverageReport,
  type IFilePreview,
  type ITimelineEvent,
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

const Failure = Schema.Struct({ ok: Schema.Literal(false), error: Schema.String });

// Compile-time guard that the wire schemas and the domain types stay in step.
const sameShape = <A, B extends A>(_: (a: A) => B) => {};
sameShape<ICoverageReport, (typeof CoverageReport)["Type"]>((a) => a);
sameShape<(typeof CoverageReport)["Type"], ICoverageReport>((a) => a);
sameShape<IFilePreview, (typeof FilePreview)["Type"]>((a) => a);
sameShape<(typeof FilePreview)["Type"], IFilePreview>((a) => a);
sameShape<ITimelineEvent, (typeof TimelineEvent)["Type"]>((a) => a);
sameShape<(typeof TimelineEvent)["Type"], ITimelineEvent>((a) => a);

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
          timeline: Schema.optionalKey(Schema.Struct({ events: Schema.Array(TimelineEvent), omitted: Schema.Number })),
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
