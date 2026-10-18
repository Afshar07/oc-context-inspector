import { mkdir, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
  aggregateUsage,
  AnalysisService,
  buildProjectPrompt,
  buildSessionPrompt,
  extractOutline,
  formatTimeline,
  toSections,
} from "../src/analysis.js";
import { CoverageService, summarize } from "../src/coverage.js";
import { ContextPathMatcher, DEFAULT_CONTEXT_PATHS } from "../src/matcher.js";
import { JsonlContextReadStore } from "../src/store.js";
import {
  EDeliverySource,
  EReadStatus,
  ESessionTracking,
  ETimelineKind,
  type IContextReadRecord,
  type ISessionObservation,
  type ITimelineEvent,
} from "../src/types.js";
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
    // 4,000 task characters plus the fixed instructions; an uncapped task would add 6,000 more.
    expect(withContent.length).toBeLessThan(8_000);
  });

  it("asks for categorized findings and says ordering is unknown without a timeline", () => {
    const prompt = buildSessionPrompt({ task: ["t"], files: [] });
    for (const word of ["context-discovery", "instruction-adherence", "verification-reporting", "agent-oversight", "tracking-limitation"]) {
      expect(prompt).toContain(word);
    }
    expect(prompt).toContain("never a documentation change");
    expect(prompt).toContain("## Timeline");
    expect(prompt).toContain("unavailable");
  });

  it("renders the timeline in order, reads with what they delivered, commands only when allowed", () => {
    const events: ITimelineEvent[] = [
      { at: "2026-01-01T10:00:00.000Z", sessionID: "lead", kind: ETimelineKind.User, text: "fix it" },
      { at: "2026-01-01T10:00:01.000Z", sessionID: "lead", kind: ETimelineKind.Tool, tool: "read", status: "completed", path: "AGENTS.md", callID: "c1" },
      { at: "2026-01-01T10:00:02.000Z", sessionID: "lead", kind: ETimelineKind.Tool, tool: "edit", status: "error", path: "a.ts", text: "no match" },
      { at: "2026-01-01T10:00:03.000Z", sessionID: "kid", agentID: "explore", kind: ETimelineKind.Tool, tool: "grep", status: "completed" },
      { at: "2026-01-01T10:00:04.000Z", sessionID: "lead", kind: ETimelineKind.Shell, command: "npm test", exit: 1 },
    ];
    const reads = new Map([["c1", { ...rec("lead", "AGENTS.md"), delivered: { source: EDeliverySource.Header, lineCount: 20, range: { start: 1, end: 20 }, reachedEof: false } }]]);
    const hidden = formatTimeline(events, { sessionID: "lead", reads, omitted: 4, includeCommands: false });
    expect(hidden.split("\n")).toEqual([
      "(4 earlier low-value steps omitted to fit)",
      '10:00:00 [lead] USER: "fix it"',
      "10:00:01 [lead] read AGENTS.md L1–20 delivered",
      "10:00:02 [lead] edit a.ts FAILED: no match",
      "10:00:03 [subagent explore] grep",
      "10:00:04 [lead] shell command (exit 1)",
    ]);
    expect(formatTimeline(events, { sessionID: "lead", reads, omitted: 0, includeCommands: true })).toContain("shell command (exit 1): npm test");
    expect(buildSessionPrompt({ task: [], files: [], timeline: hidden })).toContain("10:00:02 [lead] edit a.ts FAILED");
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

  it("adds the timeline, joining reads to their records, and shows commands only with includeContent", () =>
    withTempDir(async (dir) => {
      const timeline = {
        omitted: 0,
        events: [
          { at: "2026-01-01T10:00:00.000Z", sessionID: "s1", kind: ETimelineKind.Tool, tool: "read", status: "completed" as const, callID: 's1-.ai/doc.md-{"offset":2,"limit":3}' },
          { at: "2026-01-01T10:00:01.000Z", sessionID: "s1", kind: ETimelineKind.Shell, command: "npm test", exit: 0 },
        ],
      };
      const off = await setup(dir, false);
      await off.service.analyzeSession("s1", ["t"], undefined, timeline);
      expect(off.prompts[0]).toContain("read .ai/doc.md (estimated: requested offset 2, limit 3)");
      expect(off.prompts[0]).toContain("shell command (exit 0)");
      expect(off.prompts[0]).not.toContain("npm test");
      const on = await setup(dir, true);
      await on.service.analyzeSession("s1", ["t"], undefined, timeline);
      expect(on.prompts[0]).toContain("shell command (exit 0): npm test");
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
