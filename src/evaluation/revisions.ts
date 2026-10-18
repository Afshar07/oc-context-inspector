import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import * as path from "node:path";
import type { IClock } from "../types.js";
import {
  ERevisionState,
  EVALUATION_SCHEMA_VERSION,
  type IFileHash,
  type IRevisionDiff,
  type IRevisionSnapshot,
  type ISessionRevision,
  type ISessionRevisionRecord,
} from "./types.js";

const REVISION_ID_CHARS = 16;

/** Code-point order, not locale order: the fingerprint must not depend on the machine's locale. */
const byPath = (a: { readonly path: string }, b: { readonly path: string }) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);

export const toPosix = (p: string) => p.replace(/\\/g, "/");

function digest(lines: readonly string[]): string {
  return createHash("sha256").update(`v1\n${lines.join("")}`).digest("hex").slice(0, REVISION_ID_CHARS);
}

/** Aggregate id of a set of files: stable for the same paths and contents, whatever the order they were found in. */
export function revisionId(files: readonly IFileHash[]): string {
  return digest([...files].sort(byPath).map((f) => `${toPosix(f.path)}\0${f.sha256}\n`));
}

/**
 * Id of the given paths alone, so a change elsewhere in the context does not move it.
 * A path that is absent counts as absent (`-`), so adding or deleting a target changes the id.
 */
export function scopedRevisionId(files: readonly IFileHash[], paths: readonly string[]): string {
  const byName = new Map(files.map((f) => [toPosix(f.path), f.sha256]));
  return digest([...new Set(paths.map(toPosix))].sort().map((p) => `${p}\0${byName.get(p) ?? "-"}\n`));
}

export function makeSnapshot(files: readonly IFileHash[], createdAt: string): IRevisionSnapshot {
  const sorted = [...files].map((f) => ({ ...f, path: toPosix(f.path) })).sort(byPath);
  return { version: EVALUATION_SCHEMA_VERSION, id: revisionId(sorted), createdAt, files: sorted };
}

/** Added, removed, modified and renamed paths between two snapshots. Renames pair equal content in path order. */
export function diffSnapshots(before: IRevisionSnapshot, after: IRevisionSnapshot): IRevisionDiff {
  const prev = new Map(before.files.map((f) => [f.path, f.sha256]));
  const next = new Map(after.files.map((f) => [f.path, f.sha256]));
  const modified = [...next].filter(([p, sha]) => prev.has(p) && prev.get(p) !== sha).map(([p]) => p);
  const removed = [...prev.keys()].filter((p) => !next.has(p)).sort();
  const added = [...next.keys()].filter((p) => !prev.has(p)).sort();

  const renamed: { from: string; to: string }[] = [];
  const unmatchedAdded = new Set(added);
  const unmatchedRemoved: string[] = [];
  for (const from of removed) {
    const to = added.find((p) => unmatchedAdded.has(p) && next.get(p) === prev.get(from));
    if (to === undefined) unmatchedRemoved.push(from);
    else {
      unmatchedAdded.delete(to);
      renamed.push({ from, to });
    }
  }
  return {
    added: added.filter((p) => unmatchedAdded.has(p)),
    removed: unmatchedRemoved,
    modified: modified.sort(),
    renamed,
  };
}

export const isEmptyDiff = (d: IRevisionDiff) => d.added.length + d.removed.length + d.modified.length + d.renamed.length === 0;

/** Every path a diff touches. */
export const diffPaths = (d: IRevisionDiff): string[] =>
  [...d.added, ...d.removed, ...d.modified, ...d.renamed.flatMap((r) => [r.from, r.to])].sort();

/** The part of a diff that concerns `paths` (a rename counts when either side is in `paths`). */
export function restrictDiff(d: IRevisionDiff, paths: ReadonlySet<string>): IRevisionDiff {
  return {
    added: d.added.filter((p) => paths.has(p)),
    removed: d.removed.filter((p) => paths.has(p)),
    modified: d.modified.filter((p) => paths.has(p)),
    renamed: d.renamed.filter((r) => paths.has(r.from) || paths.has(r.to)),
  };
}

/** The part of a diff outside `paths`. */
export function excludeDiff(d: IRevisionDiff, paths: ReadonlySet<string>): IRevisionDiff {
  return {
    added: d.added.filter((p) => !paths.has(p)),
    removed: d.removed.filter((p) => !paths.has(p)),
    modified: d.modified.filter((p) => !paths.has(p)),
    renamed: d.renamed.filter((r) => !paths.has(r.from) && !paths.has(r.to)),
  };
}

/** SHA-256 of a file, streamed. */
export function hashFile(abs: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    createReadStream(abs)
      .on("error", reject)
      .on("data", (chunk) => hash.update(chunk))
      .on("end", () => resolve(hash.digest("hex")));
  });
}

export interface ISnapshotterOptions {
  /** How long the list of context files is reused. Contents are re-checked (stat) on every call. */
  readonly listTtlMs?: number;
  readonly clock?: IClock;
}

/**
 * Takes snapshots of the tracked context files. Cheap to call often: the file list is cached for a
 * short time, a file is re-hashed only when its mtime or size changed, and concurrent callers share one
 * run. The one blind spot is the one coverage already has: an edit that keeps mtime and size.
 */
export class RevisionSnapshotter {
  private readonly hashes = new Map<string, { mtimeMs: number; sizeBytes: number; sha256: string }>();
  private list: { at: number; paths: string[] } | undefined;
  private inflight: Promise<IRevisionSnapshot> | undefined;
  private dirty = false;
  private readonly listTtlMs: number;
  private readonly clock: IClock;

  constructor(
    private readonly root: string,
    private readonly listFiles: () => Promise<string[]>,
    options: ISnapshotterOptions = {},
  ) {
    this.listTtlMs = options.listTtlMs ?? 2000;
    this.clock = options.clock ?? { now: () => new Date() };
  }

  /** The next call re-lists the files. Called when a tool call touched a context path, so a new file is not missed. */
  invalidate(): void {
    this.dirty = true;
  }

  current(): Promise<IRevisionSnapshot> {
    this.inflight ??= this.take().finally(() => {
      this.inflight = undefined;
    });
    return this.inflight;
  }

  private async paths(): Promise<string[]> {
    const now = this.clock.now().getTime();
    if (!this.dirty && this.list && now - this.list.at < this.listTtlMs) return this.list.paths;
    this.dirty = false;
    const paths = (await this.listFiles()).map(toPosix);
    this.list = { at: now, paths };
    return paths;
  }

  private async take(): Promise<IRevisionSnapshot> {
    const files = await Promise.all(
      (await this.paths()).map(async (rel): Promise<IFileHash | undefined> => {
        const abs = path.join(this.root, rel);
        try {
          const info = await stat(abs);
          if (!info.isFile()) return undefined;
          const known = this.hashes.get(rel);
          if (known && known.mtimeMs === info.mtimeMs && known.sizeBytes === info.size) {
            return { path: rel, sha256: known.sha256, sizeBytes: info.size };
          }
          const sha256 = await hashFile(abs);
          this.hashes.set(rel, { mtimeMs: info.mtimeMs, sizeBytes: info.size, sha256 });
          return { path: rel, sha256, sizeBytes: info.size };
        } catch {
          // Deleted or unreadable since it was listed: absent from this revision.
          this.hashes.delete(rel);
          return undefined;
        }
      }),
    );
    return makeSnapshot(files.flatMap((f) => f ?? []), this.clock.now().toISOString());
  }
}

/**
 * A session's revision from its record. Stable only when the start is known and nothing else was seen;
 * a session first seen mid-run is unknown even if its later revisions agree, because the start is.
 */
export function classifySessionRevision(sessionID: string, record: ISessionRevisionRecord | undefined): ISessionRevision {
  if (!record) {
    return { sessionID, state: ERevisionState.Unknown, reason: "no revision recorded (session ran before revision tracking, or was not observed)", revisionIds: [] };
  }
  const revisionIds = [...new Set(record.observed.map((o) => o.revisionId))];
  if (record.startRevisionId === undefined) {
    return {
      sessionID,
      state: ERevisionState.Unknown,
      reason: "first seen after it had already started, so its starting revision is unknown",
      revisionIds,
    };
  }
  if (revisionIds.length > 1) {
    return {
      sessionID,
      state: ERevisionState.Mixed,
      reason: "the context changed while the session ran",
      startRevisionId: record.startRevisionId,
      revisionIds,
    };
  }
  return { sessionID, state: ERevisionState.Stable, startRevisionId: record.startRevisionId, revisionIds };
}
