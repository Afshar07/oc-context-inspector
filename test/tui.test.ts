import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { summarize } from "../src/coverage.js";
import { describeFile, isLineRead, summaryLine, visibleFiles } from "../src/tui/format.js";
import { type ICoverageClient, type ICoverageState, type IReadEvent, watchCoverage } from "../src/tui/source.js";
import { EReadStatus, type ICoverageReport, type IContextReadRecord } from "../src/types.js";

const rec = (offset?: number, limit?: number, status = EReadStatus.Completed): IContextReadRecord => ({
  sessionID: "s",
  callID: "c",
  tool: "read",
  filePath: "a.md",
  matchedPattern: "*",
  requestedRange: { ...(offset !== undefined && { offset }), ...(limit !== undefined && { limit }) },
  status,
  startedAt: "2026-01-01T00:00:00.000Z",
  completedAt: "2026-01-01T00:00:00.000Z",
});
const disk = { exists: true, lineCount: 120, mtimeMs: 0 };

describe("describeFile", () => {
  it("names the read range, repeat count and staleness", () => {
    expect(describeFile(summarize("a.md", [rec(10, 20)], disk, false))).toBe("L10–29/120");
    expect(describeFile(summarize("a.md", [rec(1, 5), rec(50, 5)], disk, false))).toBe("10/120 lines · 2×");
    expect(describeFile(summarize("a.md", [rec()], { ...disk, mtimeMs: Date.UTC(2027, 0) }, false))).toBe("changed");
  });

  it("explains error and auto-loaded rows, and stays empty for plain unread", () => {
    expect(describeFile(summarize("a.md", [rec(1, 1, EReadStatus.Error)], { exists: false, lineCount: 0 }, false))).toBe(
      "missing",
    );
    expect(describeFile(summarize("AGENTS.md", [], disk, true))).toBe("auto-loaded");
    expect(describeFile(summarize("a.md", [], disk, false))).toBe("");
  });
});

describe("summaryLine / isLineRead", () => {
  it("counts read files among existing ones", () => {
    const files = [
      summarize("a.md", [rec()], disk, false),
      summarize("b.md", [], disk, false),
      summarize("gone.md", [rec(1, 1, EReadStatus.Error)], { exists: false, lineCount: 0 }, false),
    ];
    expect(summaryLine({ sessionID: "s", files })).toBe("1/2 read");
    expect([9, 10, 29, 30].map((l) => isLineRead(l, [{ start: 10, end: 29 }]))).toEqual([false, true, true, false]);
  });
});

describe("visibleFiles", () => {
  it("hides only plain unread files unless asked to show them", () => {
    const files = [
      summarize("read.md", [rec()], disk, false),
      summarize("unread.md", [], disk, false),
      summarize("AGENTS.md", [], disk, true),
      summarize("failed.md", [rec(1, 1, EReadStatus.Error)], disk, false),
    ];
    expect(visibleFiles(files, false).map((f) => f.filePath)).toEqual(["read.md", "AGENTS.md", "failed.md"]);
    expect(visibleFiles(files, true)).toHaveLength(4);
  });
});

describe("watchCoverage", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function fakeClient() {
    const handlers: ((e: IReadEvent) => void)[] = [];
    const pending: ((r: ICoverageReport) => void)[] = [];
    const client: ICoverageClient = {
      coverage: () => new Promise((resolve) => pending.push(resolve)),
      preview: async () => undefined,
      onRead: (h) => {
        handlers.push(h);
        return () => handlers.splice(handlers.indexOf(h), 1);
      },
    };
    return { client, handlers, pending, emit: (e: IReadEvent) => handlers.forEach((h) => h(e)) };
  }
  const report = (n: number): ICoverageReport => ({ sessionID: `s${n}`, files: [] });

  it("fetches immediately and once per burst of this session's read events", async () => {
    const fake = fakeClient();
    const updates: ICoverageState[] = [];
    watchCoverage(fake.client, "s", (u) => updates.push(u));
    expect(fake.pending).toHaveLength(1);

    fake.emit({ sessionID: "other", filePath: "x" });
    fake.emit({ sessionID: "s", filePath: "x" });
    fake.emit({ sessionID: "s", filePath: "y" });
    await vi.runAllTimersAsync();
    expect(fake.pending).toHaveLength(2);
  });

  it("drops stale responses and stops after dispose", async () => {
    const fake = fakeClient();
    const updates: ICoverageState[] = [];
    const dispose = watchCoverage(fake.client, "s", (u) => updates.push(u));
    fake.emit({ sessionID: "s", filePath: "x" });
    await vi.runAllTimersAsync();

    fake.pending[1]!(report(2));
    fake.pending[0]!(report(1));
    await vi.runAllTimersAsync();
    expect(updates).toEqual([{ report: report(2) }]);

    dispose();
    expect(fake.handlers).toHaveLength(0);
  });
});
