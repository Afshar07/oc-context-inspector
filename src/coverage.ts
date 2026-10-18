import type { Dirent } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import * as path from "node:path";
import type { ContextPathMatcher } from "./matcher.js";
import { readSessionRecords } from "./store.js";
import {
  ECoverageStatus,
  EReadStatus,
  type ICoverageReport,
  type IContextReadRecord,
  type IFileCoverage,
  type IFilePreview,
  type ILineRange,
  type IRequestedRange,
} from "./types.js";

/** The read tool's default and maximum `limit` (OpenCode 2.0.32). */
export const READ_TOOL_LINE_CAP = 2000;
const MAX_PREVIEW_LINES = 2000;
const MAX_LISTED_FILES = 1000;
const SKIPPED_DIRS = new Set([".git", "node_modules"]);

/** What `summarize` needs to know about the file on disk. */
export interface IFileState {
  readonly exists: boolean;
  readonly lineCount: number;
  readonly mtimeMs?: number;
}

/** Lines a request covered: `offset` is 1-based, `limit` defaults to and is capped at the tool's cap. */
export function readRange(range: IRequestedRange, lineCount: number): ILineRange | undefined {
  const start = Math.max(1, range.offset ?? 1);
  const limit = Math.min(range.limit ?? READ_TOOL_LINE_CAP, READ_TOOL_LINE_CAP);
  const end = Math.min(start + limit - 1, lineCount);
  return start <= end ? { start, end } : undefined;
}

export function mergeRanges(ranges: readonly ILineRange[]): ILineRange[] {
  const sorted = [...ranges].sort((a, b) => a.start - b.start);
  const merged: ILineRange[] = [];
  for (const r of sorted) {
    const last = merged[merged.length - 1];
    if (last && r.start <= last.end + 1) merged[merged.length - 1] = { start: last.start, end: Math.max(last.end, r.end) };
    else merged.push(r);
  }
  return merged;
}

/** Pure: folds one file's records and disk state into its coverage verdict. */
export function summarize(
  filePath: string,
  records: readonly IContextReadRecord[],
  file: IFileState,
  autoLoaded: boolean,
): IFileCoverage {
  const completed = records.filter((r) => r.status === EReadStatus.Completed);
  const ranges = mergeRanges(
    completed.flatMap((r) => readRange(r.requestedRange, file.lineCount) ?? []),
  );
  const covered = ranges.reduce((sum, r) => sum + r.end - r.start + 1, 0);
  const lastRead = completed.reduce<string | undefined>(
    (latest, r) => (latest === undefined || r.completedAt > latest ? r.completedAt : latest),
    undefined,
  );

  let status: ECoverageStatus;
  if (completed.length > 0) status = covered >= file.lineCount ? ECoverageStatus.Full : ECoverageStatus.Partial;
  else if (records.length > 0) status = ECoverageStatus.Error;
  else status = autoLoaded ? ECoverageStatus.AutoLoaded : ECoverageStatus.Unread;

  return {
    filePath,
    status,
    exists: file.exists,
    lineCount: file.lineCount,
    ranges,
    readCount: completed.length,
    errorCount: records.length - completed.length,
    ...(lastRead !== undefined && { lastReadAt: lastRead }),
    modifiedSinceRead:
      lastRead !== undefined && file.mtimeMs !== undefined && file.mtimeMs > Date.parse(lastRead),
  };
}

function splitLines(text: string): string[] {
  if (text === "") return [];
  const lines = text.split(/\r?\n/);
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/** Reads a file's lines; undefined when it is not a readable regular file. */
async function loadFile(abs: string): Promise<{ lines: string[]; mtimeMs: number } | undefined> {
  try {
    const info = await stat(abs);
    if (!info.isFile()) return undefined;
    return { lines: splitLines(await readFile(abs, "utf8")), mtimeMs: info.mtimeMs };
  } catch {
    return undefined;
  }
}

/**
 * Answers the TUI's questions for one project: which context files exist, what a
 * session read of each, and (on demand) a file's current lines. Contents are read
 * live and returned to the caller only; nothing here writes to disk.
 */
export class CoverageService {
  constructor(
    private readonly root: string,
    private readonly matcher: ContextPathMatcher,
    private readonly options: { readonly dataDir: string; readonly autoLoaded: readonly string[] },
  ) {}

  async coverage(sessionID: string): Promise<ICoverageReport> {
    const bySession = await this.recordsByFile(sessionID);
    const paths = new Set([...(await this.listContextFiles()), ...bySession.keys()]);
    const files = await Promise.all(
      [...paths].sort().map(async (filePath) => {
        const file = await loadFile(path.join(this.root, filePath));
        return this.summarizeFile(filePath, bySession.get(filePath) ?? [], file);
      }),
    );
    return { sessionID, files };
  }

  /** Undefined when `filePath` is not a context path of this project. */
  async preview(sessionID: string, filePath: string): Promise<IFilePreview | undefined> {
    const match = this.matcher.match(filePath);
    if (!match) return undefined;
    const file = await loadFile(path.join(this.root, match.relPath));
    const records = (await this.recordsByFile(sessionID)).get(match.relPath) ?? [];
    return {
      coverage: this.summarizeFile(match.relPath, records, file),
      lines: (file?.lines ?? []).slice(0, MAX_PREVIEW_LINES),
      truncated: (file?.lines.length ?? 0) > MAX_PREVIEW_LINES,
    };
  }

  private summarizeFile(
    filePath: string,
    records: readonly IContextReadRecord[],
    file: { lines: string[]; mtimeMs: number } | undefined,
  ): IFileCoverage {
    const state: IFileState = file
      ? { exists: true, lineCount: file.lines.length, mtimeMs: file.mtimeMs }
      : { exists: false, lineCount: 0 };
    return summarize(filePath, records, state, this.options.autoLoaded.includes(filePath));
  }

  private async recordsByFile(sessionID: string): Promise<Map<string, IContextReadRecord[]>> {
    const map = new Map<string, IContextReadRecord[]>();
    for (const record of await readSessionRecords(this.options.dataDir, sessionID)) {
      const list = map.get(record.filePath);
      if (list) list.push(record);
      else map.set(record.filePath, [record]);
    }
    return map;
  }

  /** Project-relative paths of context files on disk, skipping VCS, dependencies and our own data. */
  private async listContextFiles(): Promise<string[]> {
    const found: string[] = [];
    const walk = async (dir: string): Promise<void> => {
      let entries: Dirent[];
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (found.length >= MAX_LISTED_FILES) return;
        const abs = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (!SKIPPED_DIRS.has(entry.name) && abs !== this.options.dataDir) await walk(abs);
        } else if (entry.isFile()) {
          const match = this.matcher.match(abs);
          if (match) found.push(match.relPath);
        }
      }
    };
    await walk(this.root);
    return found;
  }
}
