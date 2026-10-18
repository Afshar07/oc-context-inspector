import type { IClock } from "../types.js";
import type { RevisionSnapshotter } from "./revisions.js";
import type { EvaluationStore } from "./store.js";
import { ERevisionCapture, EVALUATION_SCHEMA_VERSION, type ISessionRevisionRecord } from "./types.js";

const MAX_OBSERVED = 50;
const MAX_LABELS = 20;

/** What the hooks tell us about a session event. Metadata only. */
export interface ISessionRevisionEvent {
  readonly sessionID: string;
  readonly source: "prompt" | "context";
  /** `provider/model[#variant]` of a model request. */
  readonly model?: string;
  readonly agent?: string;
  /** The request's messages already contain assistant or tool turns: the session started earlier. */
  readonly priorTurns?: boolean;
}

interface IPending {
  readonly at: string;
  readonly revisionId: string;
}

const addLabel = (list: readonly string[], label: string | undefined) =>
  label === undefined || label === "" || list.includes(label) ? list : [...list, label].slice(-MAX_LABELS);

/**
 * Ties each session to the context revision that was in place when it began, and notices when it changes.
 *
 * The start of a session is established only by the first model request, and only when that request
 * carries no assistant or tool turn. A `prompt` hook firing earlier supplies an earlier snapshot, which is
 * kept provisional until that request confirms the session really was new. Anything first seen later (a
 * tool call, or a request with history) is recorded as `Late`: its starting revision stays unknown, and
 * nothing is reconstructed. Later events only add revisions that differ from the last one seen.
 *
 * Each session has its own file and its own in-process queue, so concurrent sessions never interfere.
 */
export class SessionRevisionTracker {
  private readonly records = new Map<string, ISessionRevisionRecord>();
  private readonly pending = new Map<string, IPending>();
  private readonly queues = new Map<string, Promise<void>>();

  constructor(
    private readonly store: EvaluationStore,
    private readonly snapshotter: RevisionSnapshotter,
    private readonly environment: string,
    private readonly clock: IClock = { now: () => new Date() },
  ) {}

  /** Resolves when the event has been recorded. Never rejects after the queue drains; callers may ignore the promise. */
  observe(event: ISessionRevisionEvent): Promise<void> {
    const previous = this.queues.get(event.sessionID) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(() => this.apply(event));
    this.queues.set(event.sessionID, next);
    return next;
  }

  private async apply(event: ISessionRevisionEvent): Promise<void> {
    const existing = this.records.get(event.sessionID) ?? (await this.store.getSessionRecord(event.sessionID));
    // Before the model has run, the prompt only leaves a provisional snapshot; nothing is persisted yet.
    if (!existing && event.source === "prompt") {
      const snapshot = await this.snapshotter.current();
      await this.store.putSnapshot(snapshot);
      this.pending.set(event.sessionID, { at: this.clock.now().toISOString(), revisionId: snapshot.id });
      return;
    }

    const snapshot = await this.snapshotter.current();
    const at = this.clock.now().toISOString();
    if (!existing) {
      await this.store.putSnapshot(snapshot);
      const provisional = this.pending.get(event.sessionID);
      this.pending.delete(event.sessionID);
      const isStart = event.source === "context" && event.priorTurns === false;
      const observed =
        isStart && provisional && provisional.revisionId !== snapshot.id
          ? [{ at: provisional.at, revisionId: provisional.revisionId }, { at, revisionId: snapshot.id }]
          : [{ at: isStart && provisional ? provisional.at : at, revisionId: snapshot.id }];
      await this.save({
        version: EVALUATION_SCHEMA_VERSION,
        sessionID: event.sessionID,
        capture: !isStart ? ERevisionCapture.Late : provisional ? ERevisionCapture.Prompt : ERevisionCapture.FirstRequest,
        firstSeenAt: observed[0]!.at,
        ...(isStart && { startRevisionId: observed[0]!.revisionId }),
        observed,
        models: addLabel([], event.model),
        agents: addLabel([], event.agent),
        environment: this.environment,
      });
      return;
    }

    this.records.set(event.sessionID, existing);
    const last = existing.observed[existing.observed.length - 1];
    const changed = last?.revisionId !== snapshot.id;
    const models = addLabel(existing.models, event.model);
    const agents = addLabel(existing.agents, event.agent);
    if (!changed && models === existing.models && agents === existing.agents) return;
    if (changed) await this.store.putSnapshot(snapshot);
    await this.save({
      ...existing,
      observed: changed ? [...existing.observed, { at, revisionId: snapshot.id }].slice(-MAX_OBSERVED) : existing.observed,
      models,
      agents,
    });
  }

  private async save(record: ISessionRevisionRecord): Promise<void> {
    await this.store.putSessionRecord(record);
    this.records.set(record.sessionID, record);
  }
}
