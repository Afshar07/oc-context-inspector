import { mkdir, utimes, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { CoverageService, recordRange, summarize, summarizeAgents } from "../src/coverage.js";
import { ContextPathMatcher, DEFAULT_CONTEXT_PATHS } from "../src/matcher.js";
import { JsonlContextReadStore, writeSessionMarker } from "../src/store.js";
import {
  EAgentRole,
  ECoverageCertainty,
  ECoverageStatus,
  EDeliverySource,
  EReadStatus,
  ESessionLineage,
  ESessionTracking,
  type IContextReadRecord,
  type IDeliveredRead,
  type IFileFingerprint,
} from "../src/types.js";
import { withTempDir } from "./helpers.js";

let n = 0;
const T0 = Date.UTC(2026, 0, 1);

function delivered(start: number, end: number, extra: Partial<IDeliveredRead> = {}): IDeliveredRead {
  return { source: EDeliverySource.Header, lineCount: end - start + 1, range: { start, end }, reachedEof: false, ...extra };
}

function rec(extra: Partial<IContextReadRecord> = {}): IContextReadRecord {
  const at = new Date(T0 + 10_000 + n * 1000).toISOString();
  return {
    sessionID: "s1",
    callID: `c${n++}`,
    tool: "read",
    filePath: "a.md",
    matchedPattern: "*",
    requestedRange: {},
    status: EReadStatus.Completed,
    startedAt: at,
    completedAt: at,
    ...extra,
  };
}

const print = (mtimeMs: number, sizeBytes: number): IFileFingerprint => ({ mtimeMs, sizeBytes });
const disk = (lineCount: number, mtimeMs = T0, sizeBytes = lineCount * 10) => ({ exists: true, lineCount, mtimeMs, sizeBytes });
const GONE = { exists: false, lineCount: 0 };

describe("coverage prefers what the tool delivered over what was requested", () => {
  it("uses the delivered range even when it differs from the request", () => {
    // Asked for 100 lines from 10, but the file ends at 30: the tool returned 10-30.
    const r = rec({ requestedRange: { offset: 10, limit: 100 }, delivered: delivered(10, 30, { reachedEof: true, fileLines: 30 }), fileAtRead: print(T0, 300) });
    const c = summarize("a.md", [r], disk(30), false);
    // Lines 1-9 were never delivered, so the file is not fully covered.
    expect(c).toMatchObject({ status: ECoverageStatus.Partial, ranges: [{ start: 10, end: 30 }] });
    expect(c.certainty).toBe(ECoverageCertainty.Confirmed);
  });

  it("does not cap a whole-file read at the 2000-line estimate", () => {
    const r = rec({ delivered: delivered(1, 2500, { reachedEof: true, fileLines: 2500 }), fileAtRead: print(T0, 25_000) });
    expect(summarize("a.md", [r], disk(2500, T0, 25_000), false)).toMatchObject({
      status: ECoverageStatus.Full,
      ranges: [{ start: 1, end: 2500 }],
      certainty: ECoverageCertainty.Confirmed,
    });
    // The same request without delivery information is only an estimate, and says so.
    const legacy = summarize("a.md", [rec()], disk(2500), false);
    expect(legacy).toMatchObject({ status: ECoverageStatus.Partial, ranges: [{ start: 1, end: 2000 }], certainty: ECoverageCertainty.Estimated });
  });

  it("merges delivered pages of several reads", () => {
    const fp = print(T0, 600);
    const reads = [
      rec({ delivered: delivered(1, 30), fileAtRead: fp }),
      rec({ delivered: delivered(31, 60, { reachedEof: true, fileLines: 60 }), fileAtRead: fp }),
    ];
    expect(summarize("a.md", reads, disk(60, T0, 600), false)).toMatchObject({ status: ECoverageStatus.Full, ranges: [{ start: 1, end: 60 }] });
  });

  it("labels coverage estimated as soon as one counted read has no delivery information", () => {
    const fp = print(T0, 600);
    const c = summarize("a.md", [rec({ delivered: delivered(1, 30), fileAtRead: fp }), rec({ requestedRange: { offset: 31 }, fileAtRead: fp })], disk(60, T0, 600), false);
    expect(c.certainty).toBe(ECoverageCertainty.Estimated);
    expect(c.status).toBe(ECoverageStatus.Full);
  });

  it("recordRange: delivered wins, an empty delivery covers nothing, no baseline means no estimate", () => {
    expect(recordRange(rec({ delivered: delivered(5, 9), requestedRange: { offset: 1 } }), 100)).toEqual({ range: { start: 5, end: 9 }, estimated: false });
    expect(recordRange(rec({ delivered: { source: EDeliverySource.Header, lineCount: 0, reachedEof: true, fileLines: 0 } }), 100)).toEqual({ estimated: false });
    expect(recordRange(rec({ requestedRange: { offset: 3, limit: 2 } }), undefined)).toEqual({ estimated: true });
    expect(recordRange(rec({ requestedRange: { offset: 3, limit: 2 } }), 100)).toEqual({ range: { start: 3, end: 4 }, estimated: true });
  });
});

describe("empty files", () => {
  it("a delivered read of an empty file is fully covered, with confirmation", () => {
    const r = rec({ delivered: { source: EDeliverySource.Header, lineCount: 0, reachedEof: true, fileLines: 0 }, fileAtRead: print(T0, 0) });
    expect(summarize("a.md", [r], disk(0, T0, 0), false)).toMatchObject({ status: ECoverageStatus.Full, certainty: ECoverageCertainty.Confirmed, ranges: [] });
  });

  it("a legacy read of an empty file is an estimate", () => {
    expect(summarize("a.md", [rec()], disk(0), false)).toMatchObject({ status: ECoverageStatus.Full, certainty: ECoverageCertainty.Estimated });
  });
});

describe("deleted and missing files", () => {
  it("never calls a deleted file fully covered just because its current line count is zero", () => {
    const c = summarize("a.md", [rec({ requestedRange: { offset: 1, limit: 50 } })], GONE, false);
    expect(c.status).toBe(ECoverageStatus.Unknown);
    expect(c).toMatchObject({ exists: false, lineCount: 0, ranges: [], certainty: ECoverageCertainty.Estimated, modifiedSinceRead: false });
  });

  it("judges a deleted file by its size at read time when the read recorded it", () => {
    const full = rec({ delivered: delivered(1, 40, { reachedEof: true, fileLines: 40 }), fileAtRead: print(T0, 400) });
    expect(summarize("a.md", [full], GONE, false)).toMatchObject({
      status: ECoverageStatus.Full,
      certainty: ECoverageCertainty.Stale,
      lineCountAtRead: 40,
      exists: false,
      ranges: [{ start: 1, end: 40 }],
    });
    const part = rec({ delivered: delivered(1, 10, { reachedEof: true, fileLines: 40 }), fileAtRead: print(T0, 400) });
    expect(summarize("a.md", [part], GONE, false)).toMatchObject({ status: ECoverageStatus.Partial, certainty: ECoverageCertainty.Stale });
  });

  it("is Partial, not Unknown, when a deleted file's reads were cut short (more existed)", () => {
    const cut = rec({ delivered: delivered(1, 2000), fileAtRead: print(T0, 9) });
    expect(summarize("a.md", [cut], GONE, false).status).toBe(ECoverageStatus.Partial);
  });

  it("only-failed reads of a missing file stay an error", () => {
    expect(summarize("a.md", [rec({ status: EReadStatus.Error })], GONE, false)).toMatchObject({ status: ECoverageStatus.Error, exists: false });
  });
});

describe("modified and shortened files", () => {
  it("measures an unchanged file against its current size, with confirmation", () => {
    const r = rec({ delivered: delivered(1, 20), fileAtRead: print(T0, 600) });
    expect(summarize("a.md", [r], disk(60, T0, 600), false)).toMatchObject({ status: ECoverageStatus.Partial, certainty: ECoverageCertainty.Confirmed, modifiedSinceRead: false });
  });

  it("after a file is shortened, reports what was read of the old version and flags it stale", () => {
    // Read all 60 lines; the file has since been cut to 30.
    const r = rec({ delivered: delivered(1, 60, { reachedEof: true, fileLines: 60 }), fileAtRead: print(T0, 600) });
    const c = summarize("a.md", [r], disk(30, T0 + 5000, 300), false);
    expect(c).toMatchObject({
      status: ECoverageStatus.Full,
      certainty: ECoverageCertainty.Stale,
      modifiedSinceRead: true,
      lineCount: 30,
      lineCountAtRead: 60,
      ranges: [{ start: 1, end: 60 }],
    });
  });

  it("after a file grows, a complete read of the old version is not complete for the new one", () => {
    const r = rec({ delivered: delivered(1, 30, { reachedEof: true, fileLines: 30 }), fileAtRead: print(T0, 300) });
    const c = summarize("a.md", [r], disk(60, T0 + 5000, 600), false);
    // Stale: judged against its own 30 lines and flagged, never silently against the new 60.
    expect(c).toMatchObject({ certainty: ECoverageCertainty.Stale, modifiedSinceRead: true, lineCountAtRead: 30, lineCount: 60 });
  });

  it("counts only reads of the current version once the file was re-read after a change", () => {
    const old = rec({ delivered: delivered(1, 60, { reachedEof: true, fileLines: 60 }), fileAtRead: print(T0, 600) });
    const fresh = rec({ delivered: delivered(1, 10), fileAtRead: print(T0 + 5000, 450) });
    const c = summarize("a.md", [old, fresh], disk(45, T0 + 5000, 450), false);
    expect(c).toMatchObject({ status: ECoverageStatus.Partial, ranges: [{ start: 1, end: 10 }], certainty: ECoverageCertainty.Confirmed, modifiedSinceRead: false, readCount: 2 });
  });

  it("falls back to Partial or Unknown, never Full, when the old size is unknown", () => {
    const cut = rec({ delivered: delivered(1, 100), fileAtRead: print(T0, 1) });
    expect(summarize("a.md", [cut], disk(100, T0 + 5000, 2), false).status).toBe(ECoverageStatus.Partial);
    const noEof = rec({ delivered: { ...delivered(1, 100), reachedEof: true }, fileAtRead: print(T0, 1) });
    expect(summarize("a.md", [noEof], disk(100, T0 + 5000, 2), false).status).toBe(ECoverageStatus.Unknown);
  });

  it("keeps the legacy behavior for records without a fingerprint: estimated, and flagged when the file changed", () => {
    const c = summarize("a.md", [rec({ requestedRange: { offset: 10, limit: 20 } })], disk(120, T0 + 999_999_999), false);
    expect(c).toMatchObject({ status: ECoverageStatus.Partial, ranges: [{ start: 10, end: 29 }], certainty: ECoverageCertainty.Estimated, modifiedSinceRead: true });
  });
});

describe("CoverageService end to end on disk", () => {
  async function project(dir: string) {
    await mkdir(path.join(dir, ".ai"), { recursive: true });
    const dataDir = path.join(dir, "data");
    const service = new CoverageService(dir, new ContextPathMatcher(dir, DEFAULT_CONTEXT_PATHS), { dataDir, autoLoaded: [] });
    return { dataDir, service, store: new JsonlContextReadStore(dataDir) };
  }

  it("preview warns when the file changed or vanished, and not when it is unchanged", () =>
    withTempDir(async (dir) => {
      const { service, store } = await project(dir);
      const file = path.join(dir, ".ai/a.md");
      await writeFile(file, "1\n2\n3\n");
      const info = await (await import("node:fs/promises")).stat(file);
      await store.append(
        rec({ filePath: ".ai/a.md", delivered: delivered(1, 3, { reachedEof: true, fileLines: 3 }), fileAtRead: print(info.mtimeMs, info.size) }),
      );
      const unchanged = await service.preview("s1", ".ai/a.md");
      expect(unchanged).toMatchObject({ contentMayDiffer: false, coverage: { status: ECoverageStatus.Full, certainty: ECoverageCertainty.Confirmed } });

      await writeFile(file, "1\n2\n3\n4\n5\n");
      await utimes(file, new Date(info.mtimeMs + 60_000), new Date(info.mtimeMs + 60_000));
      const changed = await service.preview("s1", ".ai/a.md");
      expect(changed).toMatchObject({ contentMayDiffer: true, coverage: { modifiedSinceRead: true, certainty: ECoverageCertainty.Stale, lineCount: 5, lineCountAtRead: 3 } });

      await (await import("node:fs/promises")).rm(file);
      const gone = await service.preview("s1", ".ai/a.md");
      expect(gone).toMatchObject({ contentMayDiffer: true, lines: [], coverage: { exists: false, status: ECoverageStatus.Full, certainty: ECoverageCertainty.Stale } });
    }));

  it("an unread file never claims its preview may differ", () =>
    withTempDir(async (dir) => {
      const { service } = await project(dir);
      await writeFile(path.join(dir, ".ai/a.md"), "x\n");
      expect(await service.preview("s1", ".ai/a.md")).toMatchObject({ contentMayDiffer: false });
    }));
});

describe("agent attribution", () => {
  const lead = { sessionID: "lead", lineage: ESessionLineage.Root, agentID: "build" } as const;
  const sub = { sessionID: "sub", lineage: ESessionLineage.Child, parentSessionID: "lead", agentID: "explore" } as const;

  it("tells a lead agent's reads from a subagent's, and keeps the original session and call IDs", () => {
    const records = [rec({ ...lead, callID: "L1", delivered: delivered(1, 10) }), rec({ ...sub, callID: "S1", delivered: delivered(11, 20) })];
    const agents = summarizeAgents(records, 100, new Map([["lead", 0], ["sub", 1]]));
    expect(agents.map((a) => [a.sessionID, a.agentID, a.role, a.depth, a.parentSessionID])).toEqual([
      ["lead", "build", EAgentRole.Lead, 0, undefined],
      ["sub", "explore", EAgentRole.Subagent, 1, "lead"],
    ]);
    expect(records.map((r) => [r.sessionID, r.callID])).toEqual([["lead", "L1"], ["sub", "S1"]]);
  });

  it("separates repeated reads within one agent from re-reads after a handoff", () => {
    const at = (i: number) => new Date(T0 + i * 1000).toISOString();
    const records = [
      rec({ ...lead, completedAt: at(1), delivered: delivered(1, 20) }),
      rec({ ...lead, completedAt: at(2), delivered: delivered(10, 30) }), // overlaps its own earlier read
      rec({ ...sub, completedAt: at(3), delivered: delivered(15, 25) }), // overlaps what the lead already had
      rec({ ...sub, completedAt: at(4), delivered: delivered(50, 60) }), // new lines
      rec({ ...sub, completedAt: at(5), delivered: delivered(55, 58) }), // overlaps its own earlier read
    ];
    const [l, s] = summarizeAgents(records, 100);
    expect(l).toMatchObject({ agentID: "build", readCount: 2, repeatReads: 1, handoffRereads: 0 });
    expect(s).toMatchObject({ agentID: "explore", readCount: 3, repeatReads: 1, handoffRereads: 1 });
  });

  it("does not count adjacent, non-overlapping reads as repeats", () => {
    const [a] = summarizeAgents([rec({ ...lead, delivered: delivered(1, 10) }), rec({ ...lead, delivered: delivered(11, 20) })], 100);
    expect(a).toMatchObject({ repeatReads: 0, handoffRereads: 0, ranges: [{ start: 1, end: 20 }] });
  });

  it("separates two agents that share one session (an agent switch)", () => {
    const records = [
      rec({ sessionID: "x", agentID: "plan", delivered: delivered(1, 5) }),
      rec({ sessionID: "x", agentID: "build", delivered: delivered(1, 5) }),
    ];
    const agents = summarizeAgents(records, 10);
    expect(agents.map((a) => [a.agentID, a.repeatReads, a.handoffRereads])).toEqual([["plan", 0, 0], ["build", 0, 1]]);
  });

  it("handles missing attribution without guessing", () => {
    const [a] = summarizeAgents([rec({ delivered: delivered(1, 5) })], 10);
    expect(a?.agentID).toBeUndefined();
    expect(a?.role).toBe(EAgentRole.Unknown);
    expect(a?.parentSessionID).toBeUndefined();
  });

  it("counts a failed read against its agent without treating it as a read", () => {
    const [a] = summarizeAgents([rec({ ...lead, status: EReadStatus.Error })], 10);
    expect(a).toMatchObject({ readCount: 0, errorCount: 1, repeatReads: 0, ranges: [] });
  });

  it("treats a read of unknown extent as overlapping any earlier read, and a first read as new", () => {
    const [a, b] = summarizeAgents(
      [rec({ ...lead, requestedRange: {} }), rec({ ...lead, requestedRange: {} }), rec({ ...sub, requestedRange: {} })],
      undefined,
    );
    expect(a).toMatchObject({ readCount: 2, repeatReads: 1 });
    expect(b).toMatchObject({ readCount: 1, handoffRereads: 1 });
  });

  it("status follows the viewed session only; subagent reads are listed apart", () => {
    const own = [rec({ ...lead, delivered: delivered(1, 10), fileAtRead: print(T0, 100) })];
    const delegated = [rec({ ...sub, delivered: delivered(1, 100, { reachedEof: true, fileLines: 100 }), fileAtRead: print(T0, 100) })];
    const c = summarize("a.md", own, disk(100, T0, 100), false, delegated, new Map([["lead", 0], ["sub", 1]]));
    expect(c.status).toBe(ECoverageStatus.Partial);
    expect(c.readCount).toBe(1);
    expect(c.agents.map((a) => a.agentID)).toEqual(["build", "explore"]);
    expect(c.handoffRereads).toBe(1);
  });

  it("a file only a subagent read is unread for the lead", () => {
    const c = summarize("a.md", [], disk(10), false, [rec({ ...sub, delivered: delivered(1, 10) })]);
    expect(c.status).toBe(ECoverageStatus.Unread);
    expect(c.agents).toHaveLength(1);
  });
});

describe("CoverageService follows delegation", () => {
  it("includes nested subagents, attributes each read, and keeps concurrent sessions apart", () =>
    withTempDir(async (dir) => {
      await mkdir(path.join(dir, ".ai"), { recursive: true });
      await writeFile(path.join(dir, ".ai/a.md"), Array.from({ length: 20 }, (_, i) => `l${i}`).join("\n") + "\n");
      const dataDir = path.join(dir, "data");
      const service = new CoverageService(dir, new ContextPathMatcher(dir, DEFAULT_CONTEXT_PATHS), { dataDir, autoLoaded: [] });
      const store = new JsonlContextReadStore(dataDir);
      const ts = (d: number) => new Date(Date.now() + d * 1000).toISOString();
      const mark = (sessionID: string, extra = {}) => writeSessionMarker(dataDir, { version: 1, sessionID, firstObservedAt: ts(0), ...extra });
      await mark("lead", { lineage: ESessionLineage.Root });
      await mark("sub", { lineage: ESessionLineage.Child, parentSessionID: "lead" });
      await mark("subsub", { lineage: ESessionLineage.Child, parentSessionID: "sub" });
      await mark("other", { lineage: ESessionLineage.Root });
      const r = (sessionID: string, agentID: string, from: number, to: number, d: number, lineage: ESessionLineage, parentSessionID?: string) =>
        store.append(rec({ sessionID, agentID, filePath: ".ai/a.md", lineage, ...(parentSessionID && { parentSessionID }), delivered: delivered(from, to), completedAt: ts(d) }));
      await r("lead", "build", 1, 5, 1, ESessionLineage.Root);
      await r("sub", "explore", 3, 8, 2, ESessionLineage.Child, "lead");
      await r("subsub", "general", 6, 9, 3, ESessionLineage.Child, "sub");
      await r("other", "build", 1, 20, 4, ESessionLineage.Root);

      const report = await service.coverage("lead");
      expect(report.tracking).toBe(ESessionTracking.Observed);
      const file = report.files.find((f) => f.filePath === ".ai/a.md")!;
      expect(file.ranges).toEqual([{ start: 1, end: 5 }]);
      expect(file.agents.map((a) => [a.agentID, a.role, a.depth])).toEqual([
        ["build", EAgentRole.Lead, 0],
        ["explore", EAgentRole.Subagent, 1],
        ["general", EAgentRole.Subagent, 2],
      ]);
      expect(file.handoffRereads).toBe(2);

      const other = (await service.coverage("other")).files.find((f) => f.filePath === ".ai/a.md")!;
      expect(other.agents).toHaveLength(1);
      expect(other.handoffRereads).toBe(0);
    }));

  it("reports a session the plugin never saw as unobserved", () =>
    withTempDir(async (dir) => {
      const service = new CoverageService(dir, new ContextPathMatcher(dir, DEFAULT_CONTEXT_PATHS), { dataDir: path.join(dir, "data"), autoLoaded: [] });
      expect((await service.coverage("ghost")).tracking).toBe(ESessionTracking.Unobserved);
    }));
});
