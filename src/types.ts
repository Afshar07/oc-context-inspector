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
}

/** The subset of the V2 `tool.hook("execute.after")` event the tracker reads. */
export interface IToolAfterEvent {
  readonly tool: string;
  readonly sessionID: string;
  readonly id: string;
  readonly status: "completed" | "error";
  readonly error?: { readonly message: string };
}

export interface IContextReadStore {
  append(record: IContextReadRecord): Promise<void>;
}

export interface IClock {
  now(): Date;
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
}

/** 1-based, inclusive line range. */
export interface ILineRange {
  readonly start: number;
  readonly end: number;
}

export interface IFileCoverage {
  /** Project-relative POSIX path. */
  readonly filePath: string;
  readonly status: ECoverageStatus;
  /** False for paths that were requested but are not (or no longer) files on disk. */
  readonly exists: boolean;
  readonly lineCount: number;
  /** Merged ranges of successful reads, clamped to the file. */
  readonly ranges: readonly ILineRange[];
  readonly readCount: number;
  readonly errorCount: number;
  readonly lastReadAt?: string;
  /** The file changed on disk after its last successful read. */
  readonly modifiedSinceRead: boolean;
}

export interface ICoverageReport {
  readonly sessionID: string;
  readonly files: readonly IFileCoverage[];
}

/** Current file contents plus what the session read of it. Read live, never persisted. */
export interface IFilePreview {
  readonly coverage: IFileCoverage;
  readonly lines: readonly string[];
  /** The file has more lines than `lines` holds. */
  readonly truncated: boolean;
}
