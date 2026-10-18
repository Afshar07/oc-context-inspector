import type { Dirent } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import * as path from "node:path";
import type { ContextPathMatcher } from "./matcher.js";
import { SessionRegistry } from "./sessions.js";
import { readSessionRecords } from "./store.js";
import {
  EAgentRole,
  ECoverageCertainty,
  ECoverageStatus,
  EReadStatus,
  ESessionLineage,
  type IAgentReadSummary,
  type ICoverageReport,
  type IContextReadRecord,
  type IFileCoverage,
  type IFilePreview,
  type ILineRange,
  type IRequestedRange,
} from "./types.js";

/** The read tool's default and maximum `limit` (OpenCode 2.0.32). Only used to estimate reads that left no delivery record. */
export const READ_TOOL_LINE_CAP = 2000;
const MAX_PREVIEW_LINES = 2000;
const MAX_LISTED_FILES = 1000;
const SKIPPED_DIRS = new Set([".git", "node_modules"]);

/** What `summarize` needs to know about the file on disk. */
export interface IFileState {
  readonly exists: boolean;
  readonly lineCount: number;
  readonly mtimeMs?: number;
  readonly sizeBytes?: number;
}

/** Lines a request covered: `offset` is 1-based, `limit` defaults to and is capped at the tool's cap. An estimate. */
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

const overlaps = (a: ILineRange, ranges: readonly ILineRange[]) => ranges.some((r) => r.start <= a.end && r.end >= a.start);

export interface IReadRange {
  /** Lines the read covered; absent when none, or when they cannot be estimated. */
  readonly range?: ILineRange;
  /** Taken from the requested range, not from what the tool returned. */
  readonly estimated: boolean;
}

/**
 * The lines one successful read covered. What the tool delivered wins; a record without
 * delivery information falls back to its requested range clamped to `lineLimit` (the
 * file's line count), or to nothing when that is unknown.
 */
export function recordRange(record: IContextReadRecord, lineLimit: number | undefined): IReadRange {
  if (record.delivered) return { ...(record.delivered.range && { range: record.delivered.range }), estimated: false };
  const range = lineLimit === undefined ? undefined : readRange(record.requestedRange, lineLimit);
  return { ...(range && { range }), estimated: true };
}

/** Whether `record` read the file as it is now. A record without a fingerprint is judged by the file's mtime. */
function readCurrentVersion(record: IContextReadRecord, file: IFileState): boolean {
  if (!file.exists) return false;
  if (file.mtimeMs === undefined) return true;
  const at = record.fileAtRead;
  if (at) return at.mtimeMs === file.mtimeMs && (file.sizeBytes === undefined || at.sizeBytes === file.sizeBytes);
  return !(file.mtimeMs > Date.parse(record.completedAt));
}

const versionKey = (r: IContextReadRecord) => (r.fileAtRead ? `${r.fileAtRead.mtimeMs}:${r.fileAtRead.sizeBytes}` : "unversioned");

const byCompletion = (a: IContextReadRecord, b: IContextReadRecord) => a.completedAt.localeCompare(b.completedAt);

/** Total lines the file had when read, from the latest read that reached its end. */
function lineCountAtRead(records: readonly IContextReadRecord[]): number | undefined {
  for (const r of [...records].sort(byCompletion).reverse()) {
    if (r.delivered?.fileLines !== undefined) return r.delivered.fileLines;
  }
  return undefined;
}

const sum = (ranges: readonly ILineRange[]) => ranges.reduce((n, r) => n + r.end - r.start + 1, 0);

function roleOf(record: IContextReadRecord): EAgentRole {
  if (record.lineage === ESessionLineage.Root) return EAgentRole.Lead;
  if (record.lineage === ESessionLineage.Child) return EAgentRole.Subagent;
  return EAgentRole.Unknown;
}

interface IAgentAccumulator {
  sessionID: string;
  agentID?: string;
  role: EAgentRole;
  parentSessionID?: string;
  depth: number;
  readCount: number;
  errorCount: number;
  repeatReads: number;
  handoffRereads: number;
  ranges: ILineRange[];
  lastReadAt?: string;
}

/**
 * Per agent (one session + agent ID) read counts, and which successful reads re-read lines
 * the same agent already had (repeat) or that another agent had before it (handoff).
 * A read whose lines are unknown counts as overlapping any earlier read.
 */
export function summarizeAgents(
  records: readonly IContextReadRecord[],
  lineLimit: number | undefined,
  depths: ReadonlyMap<string, number> = new Map(),
): IAgentReadSummary[] {
  const actors = new Map<string, IAgentAccumulator>();
  const seen = new Map<string, { ranges: ILineRange[]; reads: number }>();
  for (const r of [...records].sort(byCompletion)) {
    const key = `${r.sessionID}\u0000${r.agentID ?? ""}`;
    let actor = actors.get(key);
    if (!actor) {
      actor = {
        sessionID: r.sessionID,
        role: roleOf(r),
        depth: depths.get(r.sessionID) ?? 0,
        readCount: 0,
        errorCount: 0,
        repeatReads: 0,
        handoffRereads: 0,
        ranges: [],
        ...(r.agentID !== undefined && { agentID: r.agentID }),
        ...(r.parentSessionID !== undefined && { parentSessionID: r.parentSessionID }),
      };
      actors.set(key, actor);
      seen.set(key, { ranges: [], reads: 0 });
    }
    if (r.status !== EReadStatus.Completed) {
      actor.errorCount++;
      continue;
    }
    const { range } = recordRange(r, lineLimit);
    const mine = seen.get(key)!;
    let others = { ranges: [] as ILineRange[], reads: 0 };
    for (const [otherKey, other] of seen) {
      if (otherKey !== key) others = { ranges: [...others.ranges, ...other.ranges], reads: others.reads + other.reads };
    }
    const hits = (earlier: { ranges: ILineRange[]; reads: number }) =>
      range ? overlaps(range, earlier.ranges) : earlier.reads > 0;
    if (hits(mine)) actor.repeatReads++;
    if (hits(others)) actor.handoffRereads++;
    mine.reads++;
    if (range) mine.ranges.push(range);
    actor.readCount++;
    actor.lastReadAt = r.completedAt;
    if (range) actor.ranges.push(range);
  }
  return [...actors.values()]
    .map((a) => ({ ...a, ranges: mergeRanges(a.ranges) }))
    .sort((a, b) => a.depth - b.depth);
}

/**
 * Pure: folds one file's records and disk state into its coverage verdict.
 *
 * `records` are this session's reads and decide the status and ranges. `delegated` are
 * reads by sessions it spawned: they only add to the per-agent breakdown, because the
 * lead agent's context holds what it read itself.
 *
 * Ranges come from what the tool delivered. Only reads of the file's current version count
 * toward its current coverage; when the file changed or vanished since every read, the
 * latest version that was read is judged against its own line count (`Stale`), and
 * without one the status is `Unknown`, never `Full`.
 */
export function summarize(
  filePath: string,
  records: readonly IContextReadRecord[],
  file: IFileState,
  autoLoaded: boolean,
  delegated: readonly IContextReadRecord[] = [],
  depths: ReadonlyMap<string, number> = new Map(),
): IFileCoverage {
  const completed = records.filter((r) => r.status === EReadStatus.Completed).sort(byCompletion);
  const lastRecord = completed[completed.length - 1];

  const current = completed.filter((r) => readCurrentVersion(r, file));
  const stale = completed.length > 0 && current.length === 0;
  const counted = stale ? completed.filter((r) => versionKey(r) === versionKey(lastRecord!)) : current;
  const atRead = lineCountAtRead(counted);
  // The line count the counted reads are measured against. When the file changed or vanished it is the count at
  // read time; reads that left no delivery record on a file that still exists are estimated against its current
  // size (flagged `Estimated` and `modifiedSinceRead`). A gone file is never measured by its current size.
  const estimateOnCurrent = stale && file.exists && counted.every((r) => r.delivered === undefined);
  const total = stale ? (atRead ?? (estimateOnCurrent ? file.lineCount : undefined)) : file.lineCount;

  const items = counted.map((r) => recordRange(r, total));
  const ranges = mergeRanges(items.flatMap((i) => i.range ?? []));
  const estimated = items.some((i) => i.estimated);

  let status: ECoverageStatus;
  if (completed.length > 0) {
    if (total !== undefined) status = sum(ranges) >= total ? ECoverageStatus.Full : ECoverageStatus.Partial;
    else if (counted.some((r) => r.delivered && !r.delivered.reachedEof)) status = ECoverageStatus.Partial;
    else status = ECoverageStatus.Unknown;
  } else if (records.length > 0) status = ECoverageStatus.Error;
  else status = autoLoaded ? ECoverageStatus.AutoLoaded : ECoverageStatus.Unread;

  const agents = summarizeAgents([...records, ...delegated], file.exists ? file.lineCount : undefined, depths);
  return {
    filePath,
    status,
    exists: file.exists,
    lineCount: file.lineCount,
    ranges,
    readCount: completed.length,
    errorCount: records.length - completed.length,
    ...(lastRecord && { lastReadAt: lastRecord.completedAt }),
    modifiedSinceRead: lastRecord !== undefined && file.exists && !readCurrentVersion(lastRecord, file),
    certainty: estimated ? ECoverageCertainty.Estimated : stale ? ECoverageCertainty.Stale : ECoverageCertainty.Confirmed,
    ...(atRead !== undefined && { lineCountAtRead: atRead }),
    agents,
    repeatReads: agents.reduce((n, a) => n + a.repeatReads, 0),
    handoffRereads: agents.reduce((n, a) => n + a.handoffRereads, 0),
  };
}

function splitLines(text: string): string[] {
  if (text === "") return [];
  const lines = text.split(/\r?\n/);
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

interface ILoadedFile {
  readonly lines: string[];
  readonly mtimeMs: number;
  readonly sizeBytes: number;
}

/** Reads a file's lines; undefined when it is not a readable regular file. */
export async function loadFile(abs: string): Promise<ILoadedFile | undefined> {
  try {
    const info = await stat(abs);
    if (!info.isFile()) return undefined;
    return { lines: splitLines(await readFile(abs, "utf8")), mtimeMs: info.mtimeMs, sizeBytes: info.size };
  } catch {
    return undefined;
  }
}

interface IFileRecords {
  readonly own: IContextReadRecord[];
  readonly delegated: IContextReadRecord[];
}

/**
 * Answers the TUI's questions for one project: which context files exist, what a
 * session (and the agents it spawned) read of each, and (on demand) a file's current
 * lines. Contents are read live and returned to the caller only; nothing here writes to disk.
 */
export class CoverageService {
  private readonly registry: SessionRegistry;

  constructor(
    private readonly root: string,
    private readonly matcher: ContextPathMatcher,
    private readonly options: { readonly dataDir: string; readonly autoLoaded: readonly string[] },
    registry?: SessionRegistry,
  ) {
    this.registry = registry ?? new SessionRegistry(options.dataDir);
  }

  async coverage(sessionID: string): Promise<ICoverageReport> {
    const { byFile, depths, tracking } = await this.load(sessionID);
    const paths = new Set([...(await this.listContextFiles()), ...byFile.keys()]);
    const files = await Promise.all(
      [...paths].sort().map(async (filePath) => {
        const file = await loadFile(path.join(this.root, filePath));
        return this.summarizeFile(filePath, byFile.get(filePath), file, depths);
      }),
    );
    return { sessionID, tracking, files };
  }

  /** Undefined when `filePath` is not a context path of this project. */
  async preview(sessionID: string, filePath: string): Promise<IFilePreview | undefined> {
    const match = this.matcher.match(filePath);
    if (!match) return undefined;
    const file = await loadFile(path.join(this.root, match.relPath));
    const { byFile, depths } = await this.load(sessionID);
    const coverage = this.summarizeFile(match.relPath, byFile.get(match.relPath), file, depths);
    return {
      coverage,
      lines: (file?.lines ?? []).slice(0, MAX_PREVIEW_LINES),
      truncated: (file?.lines.length ?? 0) > MAX_PREVIEW_LINES,
      // The lines shown are the file as it is now; the marks are only trustworthy for an unchanged file with delivered ranges.
      contentMayDiffer:
        coverage.readCount > 0 && (coverage.certainty !== ECoverageCertainty.Confirmed || coverage.modifiedSinceRead || !coverage.exists),
    };
  }

  /** Current lines of a project-relative file; undefined when it is not a readable file. */
  async readLines(filePath: string): Promise<string[] | undefined> {
    return (await loadFile(path.join(this.root, filePath)))?.lines;
  }

  private summarizeFile(
    filePath: string,
    records: IFileRecords | undefined,
    file: ILoadedFile | undefined,
    depths: ReadonlyMap<string, number>,
  ): IFileCoverage {
    const state: IFileState = file
      ? { exists: true, lineCount: file.lines.length, mtimeMs: file.mtimeMs, sizeBytes: file.sizeBytes }
      : { exists: false, lineCount: 0 };
    return summarize(filePath, records?.own ?? [], state, this.options.autoLoaded.includes(filePath), records?.delegated ?? [], depths);
  }

  /** Records of the session and of every session below it, grouped by file. */
  private async load(sessionID: string) {
    const [depths, observation] = await Promise.all([this.registry.tree(sessionID), this.registry.get(sessionID)]);
    // The viewed session first, then the rest by ID, so the outcome never depends on read timing.
    const ids = [...depths.keys()].sort((x, y) => (x === sessionID ? -1 : y === sessionID ? 1 : x.localeCompare(y)));
    const recordsOf = await Promise.all(ids.map((id) => readSessionRecords(this.options.dataDir, id)));
    const byFile = new Map<string, IFileRecords>();
    ids.forEach((id, i) => {
      for (const record of recordsOf[i]!) {
        let entry = byFile.get(record.filePath);
        if (!entry) byFile.set(record.filePath, (entry = { own: [], delegated: [] }));
        (id === sessionID ? entry.own : entry.delegated).push(record);
      }
    });
    return { byFile, depths, tracking: observation.tracking };
  }

  /** Project-relative paths of context files on disk, skipping VCS, dependencies and our own data. */
  async listContextFiles(): Promise<string[]> {
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
