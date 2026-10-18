import { Rpc } from "@opencode/plugin/rpc";
import { Schema } from "effect";
import { ECoverageStatus, type ICoverageReport, type IFilePreview } from "./types.js";

/** RPC methods/events need Standard Schema on both ends; Effect schemas provide it. */
const portable = <S extends Schema.ConstraintDecoder<unknown>>(schema: S) => Schema.toStandardSchemaV1(schema);

const LineRange = Schema.Struct({ start: Schema.Number, end: Schema.Number });

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
});

const CoverageReport = Schema.Struct({
  sessionID: Schema.String,
  files: Schema.Array(FileCoverage),
});

const FilePreview = Schema.Struct({
  coverage: FileCoverage,
  lines: Schema.Array(Schema.String),
  truncated: Schema.Boolean,
});

const Failure = Schema.Struct({ ok: Schema.Literal(false), error: Schema.String });

// Compile-time guard that the wire schemas and the domain types stay in step.
const sameShape = <A, B extends A>(_: (a: A) => B) => {};
sameShape<ICoverageReport, (typeof CoverageReport)["Type"]>((a) => a);
sameShape<(typeof CoverageReport)["Type"], ICoverageReport>((a) => a);
sameShape<IFilePreview, (typeof FilePreview)["Type"]>((a) => a);
sameShape<(typeof FilePreview)["Type"], IFilePreview>((a) => a);

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
      input: portable(Schema.Struct({ sessionID: Schema.String, task: Schema.Array(Schema.String) })),
      output: portable(Schema.Union([Schema.Struct({ ok: Schema.Literal(true), text: Schema.String }), Failure])),
    },
    /** Model review of how every recorded session used the project's context files. */
    reviewProject: {
      input: portable(Schema.Struct({})),
      output: portable(
        Schema.Union([
          Schema.Struct({ ok: Schema.Literal(true), text: Schema.String, sessionCount: Schema.Number }),
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
    read: { schema: portable(Schema.Struct({ sessionID: Schema.String, filePath: Schema.String })) },
  },
});
