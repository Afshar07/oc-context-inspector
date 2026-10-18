import { mkdir, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
  aggregateUsage,
  AnalysisService,
  buildProjectPrompt,
  buildSessionPrompt,
  extractOutline,
  toSections,
} from "../src/analysis.js";
import { CoverageService, summarize } from "../src/coverage.js";
import { ContextPathMatcher, DEFAULT_CONTEXT_PATHS } from "../src/matcher.js";
import { JsonlContextReadStore } from "../src/store.js";
import { EReadStatus, ESessionTracking, type IContextReadRecord, type ISessionObservation } from "../src/types.js";
import { withTempDir } from "./helpers.js";

const rec = (
  sessionID: string,
  filePath: string,
  requestedRange: IContextReadRecord["requestedRange"] = {},
  status = EReadStatus.Completed,
): IContextReadRecord => ({
  sessionID,
  callID: `${sessionID}-${filePath}-${JSON.stringify(requestedRange)}`,
  tool: "read",
  filePath,
  matchedPattern: ".ai/**",
  requestedRange,
  status,
  startedAt: "2026-01-01T00:00:00.000Z",
  completedAt: "2026-01-01T00:00:01.000Z",
});

const observed = (...ids: string[]): ISessionObservation[] =>
  ids.map((sessionID) => ({ sessionID, tracking: ESessionTracking.Observed }));

const DOC = ["intro", "# Overview", "a", "```", "# not a heading", "```", "## Data flow", "b", "# Deployment", "c"];

describe("extractOutline / toSections", () => {
  it("finds Markdown headings outside fenced code", () => {
    expect(extractOutline(DOC)).toEqual([
      { line: 2, level: 1, text: "Overview" },
      { line: 7, level: 2, text: "Data flow" },
      { line: 9, level: 1, text: "Deployment" },
    ]);
  });

  it("splits a file into heading sections, with any preamble first", () => {
    expect(toSections(extractOutline(DOC), DOC.length)).toEqual([
      { title: "(before first heading)", start: 1, end: 1 },
      { title: "# Overview", start: 2, end: 6 },
      { title: "## Data flow", start: 7, end: 8 },
      { title: "# Deployment", start: 9, end: 10 },
    ]);
    expect(toSections([], 3)).toEqual([{ title: "(whole file)", start: 1, end: 3 }]);
    expect(toSections([], 0)).toEqual([]);
  });
});

describe("aggregateUsage", () => {
  it("counts sessions per file and per section", () => {
    const bySession = new Map([
      ["s1", [rec("s1", "a.md", { offset: 2, limit: 3 }), rec("s1", "a.md", { offset: 2, limit: 3 })]],
      ["s2", [rec("s2", "a.md", { offset: 9 })]],
      ["s3", [rec("s3", "a.md", {}, EReadStatus.Error)]],
    ]);
    const usage = aggregateUsage("a.md", { exists: true, lines: DOC }, bySession, observed("s1", "s2", "s3", "s4"));
    expect(usage).toMatchObject({ sessionsTotal: 4, sessionsRead: 2, reads: 3, errors: 1 });
    expect(usage.sections.map((s) => [s.title, s.sessionsRead])).toEqual([
      ["(before first heading)", 0],
      ["# Overview", 1],
      ["## Data flow", 0],
      ["# Deployment", 1],
    ]);
  });
});

describe("prompt builders", () => {
  it("gives the session prompt the task, per-section read state and the auto-load caveat", () => {
    const coverage = summarize("a.md", [rec("s", "a.md", { offset: 2, limit: 3 })], { exists: true, lineCount: 10 }, false);
    const prompt = buildSessionPrompt({
      task: ["Add a deploy step"],
      files: [{ coverage, sections: toSections(extractOutline(DOC), 10), content: undefined }],
    });
    expect(prompt).toContain("Add a deploy step");
    expect(prompt).toContain("a.md");
    expect(prompt).toMatch(/\[partly read\] # Overview \(L2–6\)/);
    expect(prompt).toMatch(/\[not read\] # Deployment \(L9–10\)/);
    expect(prompt).toContain("auto-loaded");
    expect(prompt).not.toContain("not a heading");
  });

  it("marks a section read only when every line of it was read", () => {
    const coverage = summarize("a.md", [rec("s", "a.md", { offset: 10, limit: 30 })], { exists: true, lineCount: 60 }, false);
    const whole = buildSessionPrompt({ task: [], files: [{ coverage, sections: toSections([], 60), content: undefined }] });
    expect(whole).toContain("[partly read] (whole file) (L1–60)");
    const sections = [
      { title: "# A", start: 10, end: 39 },
      { title: "# B", start: 40, end: 60 },
    ];
    const split = buildSessionPrompt({ task: [], files: [{ coverage, sections, content: undefined }] });
    expect(split).toContain("[read] # A (L10–39)");
    expect(split).toContain("[not read] # B (L40–60)");
  });

  it("includes file contents only when given, and caps the task", () => {
    const coverage = summarize("a.md", [], { exists: true, lineCount: 1 }, false);
    const withContent = buildSessionPrompt({ task: ["x".repeat(10_000)], files: [{ coverage, sections: [], content: "SECRET BODY" }] });
    expect(withContent).toContain("SECRET BODY");
    expect(withContent.length).toBeLessThan(6_000);
  });

  it("gives the project prompt usage ratios per file and section", () => {
    const usage = aggregateUsage("a.md", { exists: true, lines: DOC }, new Map([["s1", [rec("s1", "a.md", { offset: 9 })]]]), observed("s1", "s2", "s3"));
    const note = { total: 3, observed: 3, readsOnly: 0, lead: 0, subagent: 0 };
    const prompt = buildProjectPrompt({ sessions: note, files: [{ usage, content: undefined }] });
    expect(prompt).toContain("3 recorded sessions");
    expect(prompt).toMatch(/a\.md.*read in 1\/3 sessions/);
    expect(prompt).toMatch(/# Deployment \(L9–10\): read in 1\/3 sessions/);
  });
});

async function setup(dir: string, includeContent: boolean) {
  await mkdir(path.join(dir, ".ai"), { recursive: true });
  await writeFile(path.join(dir, ".ai/doc.md"), DOC.join("\n") + "\n");
  await writeFile(path.join(dir, "AGENTS.md"), "# Agents\n");
  const dataDir = path.join(dir, ".opencode/context-inspector");
  const store = new JsonlContextReadStore(dataDir);
  await store.append(rec("s1", ".ai/doc.md", { offset: 2, limit: 3 }));
  await store.append(rec("s2", "AGENTS.md"));
  const prompts: string[] = [];
  const coverage = new CoverageService(dir, new ContextPathMatcher(dir, DEFAULT_CONTEXT_PATHS), {
    dataDir,
    autoLoaded: ["AGENTS.md"],
  });
  const service = new AnalysisService(
    coverage,
    dataDir,
    async (prompt) => {
      prompts.push(prompt);
      return "MODEL ANSWER";
    },
    { includeContent },
  );
  return { service, prompts };
}

describe("AnalysisService", () => {
  it("analyzes one session from its coverage and outlines", () =>
    withTempDir(async (dir) => {
      const { service, prompts } = await setup(dir, false);
      expect(await service.analyzeSession("s1", ["Explain the data flow"])).toBe("MODEL ANSWER");
      expect(prompts[0]).toContain("Explain the data flow");
      expect(prompts[0]).toMatch(/\[partly read\] # Overview/);
      expect(prompts[0]).not.toContain("intro\n");
    }));

  it("reviews the project across every recorded session", () =>
    withTempDir(async (dir) => {
      const { service, prompts } = await setup(dir, true);
      expect(await service.reviewProject()).toEqual({ text: "MODEL ANSWER", sessionCount: 2, readsOnlySessions: 2 });
      expect(prompts[0]).toContain("2 recorded sessions");
      expect(prompts[0]).toMatch(/\.ai\/doc\.md.*read in 1\/2 sessions/);
      expect(prompts[0]).toContain("# not a heading");
    }));

  it("still analyzes a session that read nothing: what it missed is the point", () =>
    withTempDir(async (dir) => {
      const { service, prompts } = await setup(dir, false);
      await service.analyzeSession("nobody", ["Fix the build"]);
      expect(prompts[0]).toMatch(/\[not read\] # Overview/);
    }));

  it("does not call the model when the project has no context files", () =>
    withTempDir(async (dir) => {
      const prompts: string[] = [];
      const dataDir = path.join(dir, ".opencode/context-inspector");
      const coverage = new CoverageService(dir, new ContextPathMatcher(dir, DEFAULT_CONTEXT_PATHS), {
        dataDir,
        autoLoaded: [],
      });
      const service = new AnalysisService(coverage, dataDir, async (p) => (prompts.push(p), ""), {
        includeContent: false,
      });
      await expect(service.analyzeSession("s", [])).resolves.toContain("No context files");
      await expect(service.reviewProject()).resolves.toMatchObject({ sessionCount: 0 });
      expect(prompts).toHaveLength(0);
    }));
});
