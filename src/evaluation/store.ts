import { readdir } from "node:fs/promises";
import * as path from "node:path";
import { safeName } from "../store.js";
import { readJsonFile, writeJsonAtomic } from "./json-file.js";
import { revisionId } from "./revisions.js";
import {
  EVALUATION_SCHEMA_VERSION,
  type IExperiment,
  type IRevisionSnapshot,
  type ISessionRevisionRecord,
} from "./types.js";

const EVALUATION_DIR = "evaluation";

type Obj = Readonly<Record<string, unknown>>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === "string";

function isSnapshot(v: unknown): v is IRevisionSnapshot {
  if (!isObj(v) || v.version !== EVALUATION_SCHEMA_VERSION || !isStr(v.id) || !isStr(v.createdAt) || !Array.isArray(v.files)) return false;
  const files = v.files as unknown[];
  if (!files.every((f) => isObj(f) && isStr(f.path) && isStr(f.sha256) && typeof f.sizeBytes === "number")) return false;
  // A snapshot is content-addressed: one whose files no longer hash to its id was damaged.
  return revisionId(files as IRevisionSnapshot["files"]) === v.id;
}

const isSessionRecord = (v: unknown): v is ISessionRevisionRecord =>
  isObj(v) &&
  v.version === EVALUATION_SCHEMA_VERSION &&
  isStr(v.sessionID) &&
  isStr(v.capture) &&
  isStr(v.firstSeenAt) &&
  Array.isArray(v.observed) &&
  (v.observed as unknown[]).every((o) => isObj(o) && isStr(o.at) && isStr(o.revisionId)) &&
  Array.isArray(v.models) &&
  Array.isArray(v.agents);

const isExperiment = (v: unknown): v is IExperiment =>
  isObj(v) &&
  v.version === EVALUATION_SCHEMA_VERSION &&
  isStr(v.id) &&
  isStr(v.name) &&
  isStr(v.hypothesis) &&
  isStr(v.status) &&
  Array.isArray(v.targetFiles) &&
  Array.isArray(v.sessions) &&
  Array.isArray(v.evaluations) &&
  Array.isArray(v.history) &&
  isObj(v.baseline) &&
  isStr(v.baseline.revisionId);

export interface IExperimentListing {
  readonly experiments: IExperiment[];
  /** File names that could not be read (damaged or from another schema version). Left on disk untouched. */
  readonly unreadable: string[];
}

/**
 * Evaluation metadata under `<dataDir>/evaluation/`, apart from the read logs:
 * `snapshots/` (content-addressed revisions), `sessions/` (one revision record per session) and
 * `experiments/` (one file per experiment). Every write is atomic; damaged files read as absent.
 */
export class EvaluationStore {
  private readonly root: string;

  constructor(dataDir: string) {
    this.root = path.join(dataDir, EVALUATION_DIR);
  }

  private snapshotFile = (id: string) => path.join(this.root, "snapshots", `${safeName(id)}.json`);
  private sessionFile = (sessionID: string) => path.join(this.root, "sessions", `${safeName(sessionID)}.json`);
  private experimentFile = (id: string) => path.join(this.root, "experiments", `${safeName(id)}.json`);

  async putSnapshot(snapshot: IRevisionSnapshot): Promise<void> {
    // Same id means same content, so an intact file is never rewritten; a damaged one is replaced.
    if ((await this.getSnapshot(snapshot.id)) === undefined) await writeJsonAtomic(this.snapshotFile(snapshot.id), snapshot);
  }

  async getSnapshot(id: string): Promise<IRevisionSnapshot | undefined> {
    const read = await readJsonFile(this.snapshotFile(id), isSnapshot);
    return read.status === "ok" ? read.value : undefined;
  }

  async putSessionRecord(record: ISessionRevisionRecord): Promise<void> {
    await writeJsonAtomic(this.sessionFile(record.sessionID), record);
  }

  async getSessionRecord(sessionID: string): Promise<ISessionRevisionRecord | undefined> {
    const read = await readJsonFile(this.sessionFile(sessionID), isSessionRecord);
    return read.status === "ok" ? read.value : undefined;
  }

  async putExperiment(experiment: IExperiment): Promise<void> {
    await writeJsonAtomic(this.experimentFile(experiment.id), experiment);
  }

  async getExperiment(id: string): Promise<IExperiment | undefined> {
    const read = await readJsonFile(this.experimentFile(id), isExperiment);
    return read.status === "ok" ? read.value : undefined;
  }

  async listExperiments(): Promise<IExperimentListing> {
    const dir = path.join(this.root, "experiments");
    let names: string[];
    try {
      names = await readdir(dir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { experiments: [], unreadable: [] };
      throw error;
    }
    const experiments: IExperiment[] = [];
    const unreadable: string[] = [];
    for (const name of names.filter((n) => n.endsWith(".json")).sort()) {
      const read = await readJsonFile(path.join(dir, name), isExperiment);
      if (read.status === "ok") experiments.push(read.value);
      else if (read.status === "corrupt") unreadable.push(name);
    }
    experiments.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
    return { experiments, unreadable };
  }
}
