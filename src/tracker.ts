import { stat } from "node:fs/promises";
import { parseDelivery } from "./delivery.js";
import { ContextPathMatcher } from "./matcher.js";
import {
  EReadStatus,
  type IClock,
  type IContextReadRecord,
  type IContextReadStore,
  type IFileFingerprint,
  type IRequestedRange,
  type ISessionLineage,
  type ISessionObserver,
  type IToolAfterEvent,
  type IToolBeforeEvent,
} from "./types.js";

const MAX_ERROR_LENGTH = 200;

interface IPendingRead {
  readonly filePath: string;
  readonly matchedPattern: string;
  readonly requestedRange: IRequestedRange;
  readonly startedAt: string;
  readonly agentID?: string;
  readonly messageID?: string;
  /** Resolved before the read ran, so it describes the file the agent is about to get. */
  readonly fingerprint: Promise<IFileFingerprint | undefined>;
  readonly lineage: Promise<ISessionLineage | undefined>;
}

/** Optional collaborators of the tracker; each failure degrades to "unknown", never to an error. */
export interface ITrackerDeps {
  /** Fingerprints a project-relative path. Defaults to `stat` under the matcher's root. */
  readonly fingerprint?: (relPath: string) => Promise<IFileFingerprint | undefined>;
  readonly sessions?: ISessionObserver;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

/** Copies primitives out of the (mutable) tool input; never writes to it. */
function extractTarget(input: unknown): { path: string; range: IRequestedRange } | undefined {
  if (typeof input !== "object" || input === null) return undefined;
  const args = input as Record<string, unknown>;
  const target = typeof args.path === "string" ? args.path : args.filePath;
  if (typeof target !== "string" || target === "") return undefined;
  const offset = asNumber(args.offset);
  const limit = asNumber(args.limit);
  return {
    path: target,
    range: {
      ...(offset !== undefined && { offset }),
      ...(limit !== undefined && { limit }),
    },
  };
}

/**
 * Pairs `execute.before` with `execute.after` per (session, call) and emits one
 * record per explicit context-file read. Pending state is keyed by session, so
 * concurrent sessions cannot interfere. Observation only: no event is mutated.
 */
export class ContextReadTracker {
  private readonly pending = new Map<string, Map<string, IPendingRead>>();
  private readonly fingerprint: (relPath: string) => Promise<IFileFingerprint | undefined>;
  private readonly sessions: ISessionObserver | undefined;

  constructor(
    private readonly matcher: ContextPathMatcher,
    private readonly tools: ReadonlySet<string>,
    private readonly store: IContextReadStore,
    private readonly clock: IClock = { now: () => new Date() },
    deps: ITrackerDeps = {},
  ) {
    this.sessions = deps.sessions;
    this.fingerprint =
      deps.fingerprint ??
      (async (relPath) => {
        const info = await stat(this.matcher.resolve(relPath));
        return info.isFile() ? { mtimeMs: info.mtimeMs, sizeBytes: info.size } : undefined;
      });
  }

  /** Any tool call proves its session is running, whether or not it reads context. */
  onBefore(event: IToolBeforeEvent): void {
    const lineage = this.observe(event.sessionID);
    if (!this.tools.has(event.tool)) return;
    const target = extractTarget(event.input);
    if (!target) return;
    const match = this.matcher.match(target.path);
    if (!match) return;
    let session = this.pending.get(event.sessionID);
    if (!session) this.pending.set(event.sessionID, (session = new Map()));
    const agentID = asString(event.agent);
    const messageID = asString(event.messageID);
    session.set(event.id, {
      filePath: match.relPath,
      matchedPattern: match.pattern,
      requestedRange: target.range,
      startedAt: this.clock.now().toISOString(),
      ...(agentID !== undefined && { agentID }),
      ...(messageID !== undefined && { messageID }),
      fingerprint: this.fingerprint(match.relPath).catch(() => undefined),
      lineage,
    });
  }

  async onAfter(event: IToolAfterEvent): Promise<void> {
    const session = this.pending.get(event.sessionID);
    const read = session?.get(event.id);
    if (!session || !read) return;
    session.delete(event.id);
    if (session.size === 0) this.pending.delete(event.sessionID);

    const failed = event.status === "error";
    const [fileAtRead, lineage] = await Promise.all([read.fingerprint, read.lineage]);
    const delivered = failed ? undefined : parseDelivery(event.result);
    const record: IContextReadRecord = {
      sessionID: event.sessionID,
      callID: event.id,
      tool: event.tool,
      filePath: read.filePath,
      matchedPattern: read.matchedPattern,
      requestedRange: read.requestedRange,
      status: failed ? EReadStatus.Error : EReadStatus.Completed,
      ...(failed && { errorMessage: (event.error?.message ?? "").slice(0, MAX_ERROR_LENGTH) }),
      startedAt: read.startedAt,
      completedAt: this.clock.now().toISOString(),
      ...(read.agentID !== undefined && { agentID: read.agentID }),
      ...(read.messageID !== undefined && { messageID: read.messageID }),
      ...(lineage?.parentSessionID !== undefined && { parentSessionID: lineage.parentSessionID }),
      ...(lineage?.lineage !== undefined && { lineage: lineage.lineage }),
      ...(delivered && { delivered }),
      ...(fileAtRead && { fileAtRead }),
    };
    await this.store.append(record);
  }

  /** Fire and forget: a failing session lookup must not delay or break the tool call. */
  private observe(sessionID: string): Promise<ISessionLineage | undefined> {
    if (!this.sessions) return Promise.resolve(undefined);
    return this.sessions.observe(sessionID).catch(() => undefined);
  }
}
