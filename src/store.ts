import { appendFile, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import * as path from "node:path";
import type { ESessionLineage, IContextReadRecord, IContextReadStore } from "./types.js";

/** Session IDs become file names; keep them from escaping the data directory. */
export function safeName(sessionID: string): string {
  return sessionID.replace(/[^A-Za-z0-9_-]/g, "_");
}

function sessionFile(dataDir: string, sessionID: string): string {
  return path.join(dataDir, `${safeName(sessionID)}.jsonl`);
}

const SESSIONS_DIR = "sessions";
const TRACKING_FILE = "tracking.json";

/** One file per observed session in `<dataDir>/sessions/`. Created once, so a session is never counted twice. */
export interface ISessionMarker {
  readonly version: 1;
  readonly sessionID: string;
  /** ISO time the plugin first saw the session run. */
  readonly firstObservedAt: string;
  readonly parentSessionID?: string;
  readonly lineage?: ESessionLineage;
}

/** `<dataDir>/tracking.json`: when session tracking began, so older data can be called incomplete. */
export interface ITrackingState {
  readonly version: 1;
  readonly startedAt: string;
}

const isMissing = (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT";
const isExisting = (error: unknown) => (error as NodeJS.ErrnoException).code === "EEXIST";

/** One append-only JSONL file per session. Appends keep concurrent sessions isolated. */
export class JsonlContextReadStore implements IContextReadStore {
  constructor(private readonly dataDir: string) {}

  async append(record: IContextReadRecord): Promise<void> {
    await mkdir(this.dataDir, { recursive: true });
    await appendFile(sessionFile(this.dataDir, record.sessionID), `${JSON.stringify(record)}\n`);
  }
}

export async function readSessionRecords(
  dataDir: string,
  sessionID: string,
): Promise<IContextReadRecord[]> {
  let text: string;
  try {
    text = await readFile(sessionFile(dataDir, sessionID), "utf8");
  } catch (error) {
    if (isMissing(error)) return [];
    throw error;
  }
  return text
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line) as IContextReadRecord);
}

/** IDs (file stems) of every session with records in `dataDir`. */
export async function listSessionIDs(dataDir: string): Promise<string[]> {
  let names: string[];
  try {
    names = await readdir(dataDir);
  } catch (error) {
    if (isMissing(error)) return [];
    throw error;
  }
  return names.filter((n) => n.endsWith(".jsonl")).map((n) => n.slice(0, -".jsonl".length));
}

/**
 * Writes the marker only if none exists (`wx`), so concurrent writers cannot double-count.
 * Returns the marker on disk, which is the existing one when another writer won.
 */
export async function writeSessionMarker(dataDir: string, marker: ISessionMarker): Promise<ISessionMarker> {
  const dir = path.join(dataDir, SESSIONS_DIR);
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, `${safeName(marker.sessionID)}.json`);
  try {
    await writeFile(file, JSON.stringify(marker), { flag: "wx" });
    return marker;
  } catch (error) {
    if (!isExisting(error)) throw error;
  }
  const existing = (await readSessionMarker(file)) ?? marker;
  // A marker written before the parent was known may gain its lineage; nothing else changes.
  if (existing.lineage !== undefined || marker.lineage === undefined) return existing;
  const completed: ISessionMarker = {
    ...existing,
    lineage: marker.lineage,
    ...(marker.parentSessionID !== undefined && { parentSessionID: marker.parentSessionID }),
  };
  await writeFile(file, JSON.stringify(completed));
  return completed;
}

async function readSessionMarker(file: string): Promise<ISessionMarker | undefined> {
  try {
    const marker = JSON.parse(await readFile(file, "utf8")) as Partial<ISessionMarker>;
    return marker.version === 1 && typeof marker.sessionID === "string" && typeof marker.firstObservedAt === "string"
      ? (marker as ISessionMarker)
      : undefined;
  } catch {
    // Unreadable or half-written: treated as absent; the session is then re-marked on its next event.
    return undefined;
  }
}

/**
 * Every marker in `dataDir`. `cache` (marker per file name) spares re-reading markers whose lineage is
 * settled; they never change again.
 */
export async function readSessionMarkers(dataDir: string, cache: Map<string, ISessionMarker> = new Map()): Promise<ISessionMarker[]> {
  const dir = path.join(dataDir, SESSIONS_DIR);
  let names: string[];
  try {
    names = await readdir(dir);
  } catch (error) {
    if (isMissing(error)) return [];
    throw error;
  }
  const markers = await Promise.all(
    names
      .filter((n) => n.endsWith(".json"))
      .map(async (name) => {
        const cached = cache.get(name);
        if (cached?.lineage !== undefined) return cached;
        const marker = await readSessionMarker(path.join(dir, name));
        if (marker) cache.set(name, marker);
        return marker;
      }),
  );
  return markers.flatMap((m) => m ?? []);
}

/** Records when tracking began, once. Returns the stored state, which is the earlier one when called again. */
export async function ensureTrackingState(dataDir: string, now: Date): Promise<ITrackingState> {
  await mkdir(dataDir, { recursive: true });
  const file = path.join(dataDir, TRACKING_FILE);
  const state: ITrackingState = { version: 1, startedAt: now.toISOString() };
  try {
    await writeFile(file, JSON.stringify(state), { flag: "wx" });
    return state;
  } catch (error) {
    if (!isExisting(error)) throw error;
  }
  return (await readTrackingState(dataDir)) ?? state;
}

export async function readTrackingState(dataDir: string): Promise<ITrackingState | undefined> {
  try {
    const state = JSON.parse(await readFile(path.join(dataDir, TRACKING_FILE), "utf8")) as Partial<ITrackingState>;
    return state.version === 1 && typeof state.startedAt === "string" ? (state as ITrackingState) : undefined;
  } catch {
    return undefined;
  }
}
