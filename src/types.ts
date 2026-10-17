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
