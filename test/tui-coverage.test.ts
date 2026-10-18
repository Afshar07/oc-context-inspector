import { describe, expect, it } from "vitest";
import { summarize } from "../src/coverage.js";
import { agentLines, describeFile, previewNotice, STATUS_GLYPH, trackingNote } from "../src/tui/format.js";
import { concerns } from "../src/tui/source.js";
import {
  ECoverageStatus,
  EDeliverySource,
  EReadStatus,
  ESessionLineage,
  ESessionTracking,
  type IContextReadRecord,
  type IDeliveredRead,
  type IFilePreview,
} from "../src/types.js";

const T0 = Date.UTC(2026, 0, 1);
let n = 0;
const delivered = (start: number, end: number, extra: Partial<IDeliveredRead> = {}): IDeliveredRead => ({
  source: EDeliverySource.Header,
  lineCount: end - start + 1,
  range: { start, end },
  reachedEof: false,
  ...extra,
});
const rec = (extra: Partial<IContextReadRecord> = {}): IContextReadRecord => {
  const at = new Date(T0 + 10_000 + n++ * 1000).toISOString();
  return {
    sessionID: "s",
    callID: `c${n}`,
    tool: "read",
    filePath: "a.md",
    matchedPattern: "*",
    requestedRange: {},
    status: EReadStatus.Completed,
    startedAt: at,
    completedAt: at,
    fileAtRead: { mtimeMs: T0, sizeBytes: 100 },
    ...extra,
  };
};
const disk = (lineCount: number, mtimeMs = T0, sizeBytes = 100) => ({ exists: true, lineCount, mtimeMs, sizeBytes });
const GONE = { exists: false, lineCount: 0 };

describe("describeFile with confirmed, stale and unknown coverage", () => {
  it("shows plain delivered ranges without any estimate mark", () => {
    const c = summarize("a.md", [rec({ delivered: delivered(10, 29) })], disk(120), false);
    expect(describeFile(c)).toBe("L10–29/120");
    expect(describeFile(summarize("a.md", [rec({ delivered: delivered(1, 120, { reachedEof: true, fileLines: 120 }) })], disk(120), false))).toBe("");
  });

  it("measures a changed file's ranges against its size at read time and says it changed", () => {
    const r = rec({ delivered: delivered(1, 30, { reachedEof: true, fileLines: 60 }) });
    expect(describeFile(summarize("a.md", [r], disk(20, T0 + 5000, 50), false))).toBe("L1–30/60 · changed");
  });

  it("says deleted for a file that was read and is gone, with and without known coverage", () => {
    const known = rec({ delivered: delivered(1, 40, { reachedEof: true, fileLines: 40 }) });
    expect(describeFile(summarize("a.md", [known], GONE, false))).toBe("deleted");
    const legacy = summarize("a.md", [rec({ fileAtRead: undefined })], GONE, false);
    expect(legacy.status).toBe(ECoverageStatus.Unknown);
    expect(describeFile(legacy)).toBe("deleted · coverage unknown");
    expect(STATUS_GLYPH[ECoverageStatus.Unknown]).toBe("?");
  });

  it("shows reads made by subagents next to the session's own", () => {
    const own = rec({ delivered: delivered(1, 10) });
    const sub = rec({ sessionID: "sub", lineage: ESessionLineage.Child, agentID: "explore", delivered: delivered(1, 10) });
    const c = summarize("a.md", [own], disk(50), false, [sub, sub], new Map([["s", 0], ["sub", 1]]));
    expect(describeFile(c)).toBe("L1–10/50 · +2 sub");
  });
});

describe("agentLines", () => {
  it("names each agent, its role, ranges, and how its repeats differ from handoff re-reads", () => {
    const at = (i: number) => new Date(T0 + 20_000 + i * 1000).toISOString();
    const records = [
      rec({ sessionID: "lead", agentID: "build", lineage: ESessionLineage.Root, completedAt: at(1), delivered: delivered(1, 10) }),
      rec({ sessionID: "lead", agentID: "build", lineage: ESessionLineage.Root, completedAt: at(2), delivered: delivered(5, 12) }),
      rec({ sessionID: "sub", agentID: "explore", lineage: ESessionLineage.Child, parentSessionID: "lead", completedAt: at(3), delivered: delivered(8, 9) }),
    ];
    const own = records.slice(0, 2);
    const c = summarize("a.md", own, disk(50), false, records.slice(2), new Map([["lead", 0], ["sub", 1]]));
    expect(agentLines(c)).toEqual([
      "build (lead) · 2× · L1–12 · 1 repeated by itself",
      "explore (subagent) · 1× · L8–9 · 1 repeated after handoff",
    ]);
  });

  it("does not invent an agent when attribution is missing", () => {
    expect(agentLines(summarize("a.md", [rec({ delivered: delivered(1, 3) })], disk(3), false))).toEqual(["unknown agent (agent unknown) · 1× · L1–3"]);
  });
});

describe("previewNotice", () => {
  const preview = (records: IContextReadRecord[], file: Parameters<typeof summarize>[2], contentMayDiffer: boolean): IFilePreview => ({
    coverage: summarize("a.md", records, file, false),
    lines: [],
    truncated: false,
    contentMayDiffer,
  });

  it("is silent for an unchanged file with delivered ranges", () => {
    expect(previewNotice(preview([rec({ delivered: delivered(1, 3) })], disk(3), false))).toBeUndefined();
  });

  it("warns that a changed file's text may differ from what the agent received", () => {
    const p = preview([rec({ delivered: delivered(1, 3, { reachedEof: true, fileLines: 3 }) })], disk(5, T0 + 9000, 9), true);
    expect(previewNotice(p)).toMatch(/changed since it was read.*may differ/);
  });

  it("explains a deleted file and estimated highlights", () => {
    expect(previewNotice(preview([rec({ delivered: delivered(1, 3) })], GONE, true))).toMatch(/deleted since it was read/);
    expect(previewNotice(preview([rec({ fileAtRead: undefined })], disk(5), true))).toMatch(/estimated from the requested ranges/);
  });
});

describe("trackingNote / concerns", () => {
  const report = (tracking: ESessionTracking) => ({ sessionID: "s", tracking, files: [] });

  it("only speaks up when an empty list cannot be trusted to mean nothing was read", () => {
    expect(trackingNote(report(ESessionTracking.Observed))).toBeUndefined();
    expect(trackingNote(report(ESessionTracking.Unobserved))).toMatch(/not observed/);
    expect(trackingNote(report(ESessionTracking.ReadsOnly))).toMatch(/before session tracking/);
  });

  it("refreshes a lead's view for reads in its own session and in any session below it", () => {
    expect(concerns({ sessionID: "lead", filePath: "x" }, "lead")).toBe(true);
    expect(concerns({ sessionID: "sub", filePath: "x", ancestors: ["lead"] }, "lead")).toBe(true);
    expect(concerns({ sessionID: "subsub", filePath: "x", ancestors: ["sub", "lead"] }, "lead")).toBe(true);
    expect(concerns({ sessionID: "other", filePath: "x", ancestors: ["elsewhere"] }, "lead")).toBe(false);
    expect(concerns({ sessionID: "other", filePath: "x" }, "lead")).toBe(false);
  });
});
