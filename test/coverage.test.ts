import { mkdir, utimes, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { CoverageService, mergeRanges, readRange, summarize } from "../src/coverage.js";
import { ContextPathMatcher, DEFAULT_CONTEXT_PATHS } from "../src/matcher.js";
import { JsonlContextReadStore } from "../src/store.js";
import { ECoverageStatus, EReadStatus, type IContextReadRecord } from "../src/types.js";
import { withTempDir } from "./helpers.js";

let call = 0;
const read = (
  filePath: string,
  requestedRange: IContextReadRecord["requestedRange"] = {},
  status = EReadStatus.Completed,
  completedAt = "2026-01-01T00:00:10.000Z",
): IContextReadRecord => ({
  sessionID: "s1",
  callID: `c${call++}`,
  tool: "read",
  filePath,
  matchedPattern: ".ai/**",
  requestedRange,
  status,
  startedAt: completedAt,
  completedAt,
});

const onDisk = (lineCount: number, mtimeMs = Date.UTC(2026, 0, 1)) => ({ exists: true, lineCount, mtimeMs });

describe("readRange", () => {
  it("treats offset as 1-based and defaults limit to the read tool's 2000-line cap", () => {
    expect(readRange({}, 50)).toEqual({ start: 1, end: 50 });
    expect(readRange({ offset: 10, limit: 20 }, 120)).toEqual({ start: 10, end: 29 });
    expect(readRange({ limit: 5000 }, 3000)).toEqual({ start: 1, end: 2000 });
  });

  it("clamps to the file and drops ranges past its end", () => {
    expect(readRange({ offset: 0, limit: 10 }, 5)).toEqual({ start: 1, end: 5 });
    expect(readRange({ offset: 9 }, 5)).toBeUndefined();
  });
});

describe("mergeRanges", () => {
  it("merges overlapping and adjacent ranges in order", () => {
    expect(
      mergeRanges([
        { start: 30, end: 39 },
        { start: 10, end: 29 },
        { start: 10, end: 20 },
        { start: 50, end: 60 },
      ]),
    ).toEqual([
      { start: 10, end: 39 },
      { start: 50, end: 60 },
    ]);
  });
});

describe("summarize", () => {
  it("is unread without records, or auto-loaded when OpenCode injects the file", () => {
    expect(summarize("x.md", [], onDisk(3), false).status).toBe(ECoverageStatus.Unread);
    expect(summarize("AGENTS.md", [], onDisk(3), true).status).toBe(ECoverageStatus.AutoLoaded);
  });

  it("distinguishes partial from full coverage across several reads", () => {
    const partial = summarize("a.md", [read("a.md", { offset: 10, limit: 20 })], onDisk(120), false);
    expect(partial).toMatchObject({ status: ECoverageStatus.Partial, readCount: 1, ranges: [{ start: 10, end: 29 }] });

    const full = summarize(
      "a.md",
      [read("a.md", { limit: 60 }), read("a.md", { offset: 61 })],
      onDisk(120),
      false,
    );
    expect(full).toMatchObject({ status: ECoverageStatus.Full, ranges: [{ start: 1, end: 120 }] });
  });

  it("reports error only when every read failed", () => {
    const failed = read("m.md", {}, EReadStatus.Error);
    expect(summarize("m.md", [failed], { exists: false, lineCount: 0 }, false)).toMatchObject({
      status: ECoverageStatus.Error,
      errorCount: 1,
      readCount: 0,
      exists: false,
    });
    expect(summarize("m.md", [failed, read("m.md")], onDisk(2), false).status).toBe(ECoverageStatus.Full);
  });

  it("flags files modified after their last successful read", () => {
    const records = [read("a.md", {}, EReadStatus.Completed, "2026-01-01T00:00:10.000Z")];
    expect(summarize("a.md", records, onDisk(1, Date.UTC(2026, 0, 1, 0, 0, 5)), false).modifiedSinceRead).toBe(false);
    expect(summarize("a.md", records, onDisk(1, Date.UTC(2026, 0, 1, 0, 1)), false).modifiedSinceRead).toBe(true);
  });
});

async function project(dir: string): Promise<CoverageService> {
  const write = async (rel: string, text: string) => {
    await mkdir(path.dirname(path.join(dir, rel)), { recursive: true });
    await writeFile(path.join(dir, rel), text);
  };
  await write("AGENTS.md", "# Agents\nrule\n");
  await write(".ai/architecture.md", Array.from({ length: 40 }, (_, i) => `line ${i + 1}`).join("\n") + "\n");
  await write(".ai/style.md", "style\n");
  await write("src/app.ts", "export {};\n");
  await write("node_modules/pkg/AGENTS.md", "vendored\n");
  const old = new Date(Date.UTC(2026, 0, 1));
  for (const f of ["AGENTS.md", ".ai/architecture.md", ".ai/style.md"]) await utimes(path.join(dir, f), old, old);
  return new CoverageService(dir, new ContextPathMatcher(dir, DEFAULT_CONTEXT_PATHS), {
    dataDir: path.join(dir, ".opencode/context-inspector"),
    autoLoaded: ["AGENTS.md"],
  });
}

describe("CoverageService", () => {
  it("lists every context file on disk plus missing files the session asked for", () =>
    withTempDir(async (dir) => {
      const service = await project(dir);
      const store = new JsonlContextReadStore(path.join(dir, ".opencode/context-inspector"));
      await store.append(read(".ai/architecture.md", { offset: 10, limit: 20 }));
      await store.append(read(".ai/missing.md", {}, EReadStatus.Error));

      const report = await service.coverage("s1");
      expect(report.files.map((f) => [f.filePath, f.status])).toEqual([
        [".ai/architecture.md", ECoverageStatus.Partial],
        [".ai/missing.md", ECoverageStatus.Error],
        [".ai/style.md", ECoverageStatus.Unread],
        ["AGENTS.md", ECoverageStatus.AutoLoaded],
      ]);
      expect((await service.coverage("other")).files.every((f) => f.readCount === 0)).toBe(true);
    }));

  it("previews only context files, with current lines and read ranges", () =>
    withTempDir(async (dir) => {
      const service = await project(dir);
      const store = new JsonlContextReadStore(path.join(dir, ".opencode/context-inspector"));
      await store.append(read(".ai/architecture.md", { offset: 10, limit: 20 }));

      const preview = await service.preview("s1", ".ai/architecture.md");
      expect(preview?.lines).toHaveLength(40);
      expect(preview?.lines[9]).toBe("line 10");
      expect(preview?.coverage.ranges).toEqual([{ start: 10, end: 29 }]);
      expect(await service.preview("s1", "src/app.ts")).toBeUndefined();
      expect(await service.preview("s1", "../outside.md")).toBeUndefined();
      expect((await service.preview("s1", ".ai/missing.md"))?.coverage.exists).toBe(false);
    }));
});
