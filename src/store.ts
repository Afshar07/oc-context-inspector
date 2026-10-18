import { appendFile, mkdir, readdir, readFile } from "node:fs/promises";
import * as path from "node:path";
import type { IContextReadRecord, IContextReadStore } from "./types.js";

/** Session IDs become file names; keep them from escaping the data directory. */
function sessionFile(dataDir: string, sessionID: string): string {
  return path.join(dataDir, `${sessionID.replace(/[^A-Za-z0-9_-]/g, "_")}.jsonl`);
}

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
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
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
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  return names.filter((n) => n.endsWith(".jsonl")).map((n) => n.slice(0, -".jsonl".length));
}
