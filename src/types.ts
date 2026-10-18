/** Outcome of a tracked tool call. Mirrors the `status` of the V2 `execute.after` hook. */
export enum EReadStatus {
  Completed = "completed",
  Error = "error",
}

/** Line range exactly as the agent requested it; absent fields were not passed. */
export interface IRequestedRange {
  /** `offset` argument of the read tool (start line). */
  readonly offset?: number;
  /** `limit` argument of the read tool (max number of lines). */
  readonly limit?: number;
}

/** 1-based, inclusive line range. */
export interface ILineRange {
  readonly start: number;
  readonly end: number;
}

/** Whether the session is a root (lead) session or was spawned by another one. Absent when OpenCode could not tell. */
export enum ESessionLineage {
  Root = "root",
  Child = "child",
}

/** Who performed a read, derived from the session lineage; never guessed. */
export enum EAgentRole {
  Lead = "lead",
  Subagent = "subagent",
  Unknown = "unknown",
}

/** Where the delivered line range of a read came from. */
export enum EDeliverySource {
  /** The `Read file X, lines A-B` header of the tool result. */
  Header = "header",
  /** `offset` and the line count of a paged tool result. */
  Page = "page",
}

/** What a successful read actually returned to the agent. Line numbers only: never contents. */
export interface IDeliveredRead {
  readonly source: EDeliverySource;
  /** Lines returned; 0 for an empty file. */
  readonly lineCount: number;
  /** Lines returned; absent when none were. */
  readonly range?: ILineRange;
  /** The result ended at the end of the file (the tool reported no further page). */
  readonly reachedEof: boolean;
  /** The file's total line count when it was read; known only when `reachedEof`. */
  readonly fileLines?: number;
}

/** Identifies the version of a file at read time without storing its contents. */
export interface IFileFingerprint {
  readonly mtimeMs: number;
  readonly sizeBytes: number;
}

/** One explicit read of a context file. Metadata only: never contains file contents. */
export interface IContextReadRecord {
  readonly sessionID: string;
  readonly callID: string;
  readonly tool: string;
  /** Project-relative POSIX path of the file that was read. */
  readonly filePath: string;
  /** The configured pattern that classified this file as context. */
  readonly matchedPattern: string;
  readonly requestedRange: IRequestedRange;
  readonly status: EReadStatus;
  /** Present only when `status` is `Error`; truncated. */
  readonly errorMessage?: string;
  /** ISO timestamps of `execute.before` / `execute.after`. */
  readonly startedAt: string;
  readonly completedAt: string;
  /** Agent that made the call (`agent` of the `execute.*` event). Absent in records written before attribution existed. */
  readonly agentID?: string;
  /** Message of the session the call belongs to. */
  readonly messageID?: string;
  /** Present when the session was spawned by another one (a subagent). */
  readonly parentSessionID?: string;
  /** Absent when the session lookup failed or the record predates attribution. */
  readonly lineage?: ESessionLineage;
  /** What the tool returned. Absent for failed reads, records written before this existed, and unparseable results. */
  readonly delivered?: IDeliveredRead;
  /** The file's mtime and size just before the read. Absent when it could not be stat'ed. */
  readonly fileAtRead?: IFileFingerprint;
}

/** Plugin options (`ctx.options`). */
export interface IContextInspectorOptions {
  /** Context path globs, relative to the project directory. */
  readonly contextPaths: readonly string[];
  /** Tools whose calls are inspected. */
  readonly tools: readonly string[];
  /** Directory the per-session JSONL files are written to. */
  readonly dataDir: string;
  /** Project-relative files OpenCode injects into the prompt on its own (shown as auto-loaded, not unread). */
  readonly autoLoaded: readonly string[];
  readonly analysis: IAnalysisOptions;
}

/** `analysis` plugin option: how context-usage data is sent to a model. */
export interface IAnalysisOptions {
  /** Model for analysis; the user's default model when absent. */
  readonly model?: IModelRef;
  /** Send file contents, not just heading outlines. Off by default: unread files would reach the provider. */
  readonly includeContent: boolean;
}

export interface IModelRef {
  readonly providerID: string;
  readonly id: string;
  readonly variant?: string;
}

/** The subset of the V2 `tool.hook("execute.before")` event the tracker reads. */
export interface IToolBeforeEvent {
  readonly tool: string;
  readonly sessionID: string;
  readonly id: string;
  readonly input: unknown;
  readonly agent?: string;
  readonly messageID?: string;
}

/** The subset of a V2 `Tool.Result` the tracker inspects; read, never written. */
export interface IToolResultLike {
  readonly output?: unknown;
  readonly content?: unknown;
  readonly metadata?: unknown;
}

/** The subset of the V2 `tool.hook("execute.after")` event the tracker reads. */
export interface IToolAfterEvent {
  readonly tool: string;
  readonly sessionID: string;
  readonly id: string;
  readonly status: "completed" | "error";
  readonly error?: { readonly message: string };
  readonly agent?: string;
  readonly messageID?: string;
  readonly result?: IToolResultLike;
}

export interface IContextReadStore {
  append(record: IContextReadRecord): Promise<void>;
}

export interface IClock {
  now(): Date;
}

/** How a session came to be known to the inspector. */
export enum ESessionTracking {
  /** The plugin saw the session run, so zero reads is a fact. */
  Observed = "observed",
  /** Known only from read records written before session tracking existed; sessions without reads are missing. */
  ReadsOnly = "reads-only",
  /** Never seen by the plugin: nothing can be said about its reads. */
  Unobserved = "unobserved",
}

/** A session the inspector knows about. */
export interface ISessionObservation {
  readonly sessionID: string;
  readonly tracking: ESessionTracking;
  readonly parentSessionID?: string;
  readonly lineage?: ESessionLineage;
  /** ISO time the plugin first saw the session; absent for reads-only sessions. */
  readonly firstObservedAt?: string;
}

/** Who spawned a session. Empty when OpenCode could not be asked. */
export interface ISessionLineage {
  readonly lineage?: ESessionLineage;
  readonly parentSessionID?: string;
}

/** Marks sessions as observed and resolves who spawned them. */
export interface ISessionObserver {
  observe(sessionID: string): Promise<ISessionLineage>;
}

/** Per-file verdict shown by the TUI. */
export enum ECoverageStatus {
  /** Never read, and not injected by OpenCode. */
  Unread = "unread",
  /** OpenCode injects it into the prompt itself; no explicit read was seen. */
  AutoLoaded = "auto",
  /** Some, but not all, lines were read. */
  Partial = "partial",
  /** Every line was read at least once. */
  Full = "full",
  /** Only failed reads. */
  Error = "error",
  /** Reads succeeded, but what they covered cannot be told (e.g. the file was deleted and the reads left no delivery record). */
  Unknown = "unknown",
}

/** How far the line ranges of a file's coverage can be trusted. */
export enum ECoverageCertainty {
  /** Ranges are what the tool returned, and the file is unchanged since. */
  Confirmed = "confirmed",
  /** Ranges are what the tool returned, but the file was changed or deleted since: they describe the file as it was read. */
  Stale = "stale",
  /** At least one range is only the requested one (no delivery information): the real range may differ. */
  Estimated = "estimated",
}

/** What one agent (in one session) read of a file. */
export interface IAgentReadSummary {
  readonly sessionID: string;
  /** Absent for records written before attribution existed. */
  readonly agentID?: string;
  readonly role: EAgentRole;
  readonly parentSessionID?: string;
  /** 0 for the viewed session, 1 for the sessions it spawned, and so on. */
  readonly depth: number;
  readonly readCount: number;
  readonly errorCount: number;
  /** Successful reads that re-read lines this same agent had already received. */
  readonly repeatReads: number;
  /** Successful reads that re-read lines a different agent had already received. */
  readonly handoffRereads: number;
  /** Merged ranges this agent received (or requested, when delivery is unknown). */
  readonly ranges: readonly ILineRange[];
  readonly lastReadAt?: string;
}

export interface IFileCoverage {
  /** Project-relative POSIX path. */
  readonly filePath: string;
  readonly status: ECoverageStatus;
  /** False for paths that were requested but are not (or no longer) files on disk. */
  readonly exists: boolean;
  /** Current line count on disk; 0 when the file is gone. */
  readonly lineCount: number;
  /** Merged ranges of successful reads of this session. See `certainty` for what they mean. */
  readonly ranges: readonly ILineRange[];
  readonly readCount: number;
  readonly errorCount: number;
  readonly lastReadAt?: string;
  /** The file changed on disk after its last successful read. */
  readonly modifiedSinceRead: boolean;
  readonly certainty: ECoverageCertainty;
  /** The file's line count when it was read, when the tool reported it. */
  readonly lineCountAtRead?: number;
  /** Per agent, for this session and the sessions it spawned. */
  readonly agents: readonly IAgentReadSummary[];
  /** Totals over `agents`. */
  readonly repeatReads: number;
  readonly handoffRereads: number;
}

export interface ICoverageReport {
  readonly sessionID: string;
  readonly tracking: ESessionTracking;
  readonly files: readonly IFileCoverage[];
}

/** Current file contents plus what the session read of it. Read live, never persisted. */
export interface IFilePreview {
  readonly coverage: IFileCoverage;
  readonly lines: readonly string[];
  /** The file has more lines than `lines` holds. */
  readonly truncated: boolean;
  /** `lines` may differ from what the agent received: the file changed or was deleted, or the ranges are estimates. */
  readonly contentMayDiffer: boolean;
}

/** What one timeline event is. Values are the RPC form. */
export enum ETimelineKind {
  User = "user",
  Tool = "tool",
  Shell = "shell",
  AgentSwitch = "agent-switch",
  Compaction = "compaction",
}

/**
 * One step of a session as OpenCode recorded it, reduced to metadata. Built by the TUI from the
 * session's messages and never persisted; the server decides what reaches a model prompt.
 */
export interface ITimelineEvent {
  /** ISO time the step started. */
  readonly at: string;
  readonly sessionID: string;
  readonly agentID?: string;
  readonly kind: ETimelineKind;
  readonly tool?: string;
  readonly status?: "completed" | "error";
  /** Project-relative POSIX path argument of the tool call. */
  readonly path?: string;
  /** Tool call id: the key that joins a tool step to its context-read record. */
  readonly callID?: string;
  /** User: first characters of the message. Tool: truncated error message. AgentSwitch: the agent. */
  readonly text?: string;
  /** Shell command, first line truncated. Dropped by the server unless contents may be sent. */
  readonly command?: string;
  readonly exit?: number;
}
