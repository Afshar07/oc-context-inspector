import { ContextPathMatcher } from "./matcher.js";
import {
  EReadStatus,
  type IClock,
  type IContextReadRecord,
  type IContextReadStore,
  type IRequestedRange,
  type IToolAfterEvent,
  type IToolBeforeEvent,
} from "./types.js";

const MAX_ERROR_LENGTH = 200;

interface IPendingRead {
  readonly filePath: string;
  readonly matchedPattern: string;
  readonly requestedRange: IRequestedRange;
  readonly startedAt: string;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
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

  constructor(
    private readonly matcher: ContextPathMatcher,
    private readonly tools: ReadonlySet<string>,
    private readonly store: IContextReadStore,
    private readonly clock: IClock = { now: () => new Date() },
  ) {}

  onBefore(event: IToolBeforeEvent): void {
    if (!this.tools.has(event.tool)) return;
    const target = extractTarget(event.input);
    if (!target) return;
    const match = this.matcher.match(target.path);
    if (!match) return;
    let session = this.pending.get(event.sessionID);
    if (!session) this.pending.set(event.sessionID, (session = new Map()));
    session.set(event.id, {
      filePath: match.relPath,
      matchedPattern: match.pattern,
      requestedRange: target.range,
      startedAt: this.clock.now().toISOString(),
    });
  }

  async onAfter(event: IToolAfterEvent): Promise<void> {
    const session = this.pending.get(event.sessionID);
    const read = session?.get(event.id);
    if (!session || !read) return;
    session.delete(event.id);
    if (session.size === 0) this.pending.delete(event.sessionID);

    const failed = event.status === "error";
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
    };
    await this.store.append(record);
  }
}
