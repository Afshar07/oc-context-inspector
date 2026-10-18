import {
  ensureTrackingState,
  listSessionIDs,
  readSessionMarkers,
  readTrackingState,
  type ISessionMarker,
  writeSessionMarker,
} from "./store.js";
import {
  ESessionLineage,
  ESessionTracking,
  type IClock,
  type ISessionLineage,
  type ISessionObservation,
  type ISessionObserver,
} from "./types.js";

/** What OpenCode says about a session; only the parent matters here. Undefined when the session is unknown. */
export type SessionLookup = (sessionID: string) => Promise<{ readonly parentID?: string } | undefined>;

/**
 * Marks each session as observed the first time it is seen (model request or tool call) and
 * resolves who spawned it. Idempotent per session, in memory and on disk, so a busy session
 * costs one lookup and one tiny file, and concurrent sessions never share state.
 */
export class SessionObserver implements ISessionObserver {
  private readonly settled = new Map<string, Promise<ISessionLineage>>();

  constructor(
    private readonly dataDir: string,
    private readonly lookup: SessionLookup,
    private readonly clock: IClock = { now: () => new Date() },
  ) {}

  observe(sessionID: string): Promise<ISessionLineage> {
    const known = this.settled.get(sessionID);
    if (known) return known;
    const pending = this.register(sessionID).then(
      (result) => {
        // An unresolved lookup is retried on the next event instead of being remembered as "unknown".
        if (result.lineage === undefined) this.settled.delete(sessionID);
        return result;
      },
      (error: unknown) => {
        this.settled.delete(sessionID);
        throw error;
      },
    );
    this.settled.set(sessionID, pending);
    return pending;
  }

  private async register(sessionID: string): Promise<ISessionLineage> {
    const resolved = await this.resolve(sessionID);
    const marker = await writeSessionMarker(this.dataDir, {
      version: 1,
      sessionID,
      firstObservedAt: this.clock.now().toISOString(),
      ...resolved,
    });
    return {
      ...(marker.lineage !== undefined && { lineage: marker.lineage }),
      ...(marker.parentSessionID !== undefined && { parentSessionID: marker.parentSessionID }),
    };
  }

  /** Lookup failures leave the lineage unknown: a missing parent is never inferred. */
  private async resolve(sessionID: string): Promise<ISessionLineage> {
    try {
      const info = await this.lookup(sessionID);
      if (!info) return {};
      return info.parentID
        ? { lineage: ESessionLineage.Child, parentSessionID: info.parentID }
        : { lineage: ESessionLineage.Root };
    } catch {
      return {};
    }
  }
}

function fromMarker(marker: ISessionMarker): ISessionObservation {
  return {
    sessionID: marker.sessionID,
    tracking: ESessionTracking.Observed,
    firstObservedAt: marker.firstObservedAt,
    ...(marker.lineage !== undefined && { lineage: marker.lineage }),
    ...(marker.parentSessionID !== undefined && { parentSessionID: marker.parentSessionID }),
  };
}

/** The sessions of a project that the inspector knows about, and how they relate. */
export class SessionRegistry {
  private readonly markerCache = new Map<string, ISessionMarker>();

  constructor(private readonly dataDir: string) {}

  /**
   * Observed sessions, plus sessions known only from read records written before tracking existed.
   * Each session appears once, however many files mention it. Sorted by ID.
   */
  async list(): Promise<ISessionObservation[]> {
    const [markers, withRecords] = await Promise.all([
      readSessionMarkers(this.dataDir, this.markerCache),
      listSessionIDs(this.dataDir),
    ]);
    const sessions = new Map<string, ISessionObservation>();
    // Record file names are sanitized session IDs and so are marker names; markers carry the real ID.
    for (const marker of markers) sessions.set(marker.sessionID, fromMarker(marker));
    const observedNames = new Set([...sessions.keys()].map((id) => id.replace(/[^A-Za-z0-9_-]/g, "_")));
    for (const name of withRecords) {
      if (!sessions.has(name) && !observedNames.has(name)) {
        sessions.set(name, { sessionID: name, tracking: ESessionTracking.ReadsOnly });
      }
    }
    return [...sessions.values()].sort((a, b) => a.sessionID.localeCompare(b.sessionID));
  }

  async get(sessionID: string): Promise<ISessionObservation> {
    return (await this.list()).find((s) => s.sessionID === sessionID) ?? { sessionID, tracking: ESessionTracking.Unobserved };
  }

  /** The session itself (depth 0) and every session spawned below it, by depth. Cycle-safe. */
  async tree(sessionID: string): Promise<Map<string, number>> {
    const sessions = await this.list();
    const depths = new Map<string, number>([[sessionID, 0]]);
    let frontier = [sessionID];
    while (frontier.length > 0) {
      const next: string[] = [];
      for (const parent of frontier) {
        for (const s of sessions) {
          if (s.parentSessionID === parent && !depths.has(s.sessionID)) {
            depths.set(s.sessionID, (depths.get(parent) ?? 0) + 1);
            next.push(s.sessionID);
          }
        }
      }
      frontier = next;
    }
    return depths;
  }

  /** Sessions above `sessionID`, nearest first (parent, grandparent, ...). Cycle-safe. */
  async ancestors(sessionID: string): Promise<string[]> {
    const parents = new Map((await this.list()).map((s) => [s.sessionID, s.parentSessionID]));
    const chain: string[] = [];
    for (let next = parents.get(sessionID); next !== undefined && !chain.includes(next) && next !== sessionID; next = parents.get(next)) {
      chain.push(next);
    }
    return chain;
  }

  /** When session tracking began; undefined when it never has (the plugin did not run since upgrading). */
  async trackingStartedAt(): Promise<string | undefined> {
    return (await readTrackingState(this.dataDir))?.startedAt;
  }
}

/** Records, once, when tracking began. Called at plugin start. */
export async function startTracking(dataDir: string, clock: IClock = { now: () => new Date() }): Promise<void> {
  await ensureTrackingState(dataDir, clock.now());
}
