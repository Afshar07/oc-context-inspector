import { mkdir, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
  aggregateUsage,
  AnalysisService,
  buildProjectPrompt,
  ContentBudget,
  describeSessionCoverage,
  fence,
  MAX_FILE_CONTENT_CHARS,
  MAX_TOTAL_CONTENT_CHARS,
  TRUNCATION_MARKER,
} from "../src/analysis.js";
import { CoverageService } from "../src/coverage.js";
import { ContextPathMatcher, DEFAULT_CONTEXT_PATHS } from "../src/matcher.js";
import { JsonlContextReadStore, writeSessionMarker } from "../src/store.js";
import { startTracking } from "../src/sessions.js";
import { EAgentRole, EReadStatus, ESessionLineage, ESessionTracking, type IContextReadRecord } from "../src/types.js";
import { withTempDir } from "./helpers.js";

const read = (sessionID: string, filePath: string, extra: Partial<IContextReadRecord> = {}): IContextReadRecord => ({
  sessionID,
  callID: `${sessionID}-c`,
  tool: "read",
  filePath,
  matchedPattern: ".ai/**",
  requestedRange: {},
  status: EReadStatus.Completed,
  startedAt: "2026-01-01T00:00:00.000Z",
  completedAt: "2026-01-01T00:00:01.000Z",
  ...extra,
});

const mark = (dataDir: string, sessionID: string, extra = {}) =>
  writeSessionMarker(dataDir, { version: 1, sessionID, firstObservedAt: "2026-03-01T00:00:00.000Z", lineage: ESessionLineage.Root, ...extra });

async function project(dir: string, includeContent = false, docs: Record<string, string> = { ".ai/doc.md": "# Doc\nbody\n", "AGENTS.md": "# Agents\n" }) {
  await mkdir(path.join(dir, ".ai"), { recursive: true });
  for (const [file, text] of Object.entries(docs)) await writeFile(path.join(dir, file), text);
  const dataDir = path.join(dir, "data");
  const coverage = new CoverageService(dir, new ContextPathMatcher(dir, DEFAULT_CONTEXT_PATHS), { dataDir, autoLoaded: [] });
  const prompts: string[] = [];
  const service = new AnalysisService(coverage, dataDir, async (p) => (prompts.push(p), "ANSWER"), { includeContent });
  return { dataDir, service, prompts, store: new JsonlContextReadStore(dataDir) };
}

describe("project-wide session accounting", () => {
  it("reports 2/10, not 2/2, when only 2 of 10 observed sessions read the file", () =>
    withTempDir(async (dir) => {
      const { dataDir, service, prompts, store } = await project(dir);
      await startTracking(dataDir);
      for (let i = 0; i < 10; i++) await mark(dataDir, `s${i}`);
      await store.append(read("s1", ".ai/doc.md"));
      await store.append(read("s7", ".ai/doc.md"));
      await store.append(read("s7", ".ai/doc.md")); // repeated reads do not make it two sessions

      expect(await service.reviewProject()).toMatchObject({ sessionCount: 10, readsOnlySessions: 0 });
      expect(prompts[0]).toMatch(/\.ai\/doc\.md — read in 2\/10 sessions/);
      expect(prompts[0]).toMatch(/AGENTS\.md — read in 0\/10 sessions/);
      expect(prompts[0]).toContain("across 10 recorded sessions");
      expect(prompts[0]).toContain("10 were observed running, so a session with no reads is counted as having none");
    }));

  it("counts a session with a marker and records once", () =>
    withTempDir(async (dir) => {
      const { dataDir, service, prompts, store } = await project(dir);
      await mark(dataDir, "s1");
      await store.append(read("s1", ".ai/doc.md"));
      await store.append(read("s1", "AGENTS.md"));
      expect((await service.reviewProject()).sessionCount).toBe(1);
      expect(prompts[0]).toMatch(/\.ai\/doc\.md — read in 1\/1 sessions/);
    }));

  it("keeps concurrent sessions separate", () =>
    withTempDir(async (dir) => {
      const { dataDir, service, prompts, store } = await project(dir);
      await Promise.all(["a", "b", "c", "d"].map((id) => mark(dataDir, id)));
      await Promise.all(["a", "b"].map((id) => store.append(read(id, ".ai/doc.md"))));
      await service.reviewProject();
      expect(prompts[0]).toMatch(/\.ai\/doc\.md — read in 2\/4 sessions/);
    }));

  it("keeps legacy sessions in and says the history is incomplete", () =>
    withTempDir(async (dir) => {
      const { dataDir, service, prompts, store } = await project(dir);
      await store.append(read("old1", ".ai/doc.md")); // no marker: written before tracking existed
      await store.append(read("old2", "AGENTS.md"));
      await startTracking(dataDir, { now: () => new Date("2026-03-01T00:00:00.000Z") });
      await mark(dataDir, "new1");

      expect(await service.reviewProject()).toMatchObject({ sessionCount: 3, readsOnlySessions: 2 });
      expect(prompts[0]).toMatch(/\.ai\/doc\.md — read in 1\/3 sessions/);
      expect(prompts[0]).toContain("2 are older sessions known only because they read context files");
      expect(prompts[0]).toContain("session tracking began 2026-03-01");
      expect(prompts[0]).toContain("ratios for that period are overstated");
    }));

  it("splits usage by lead and subagent sessions and by agent", () =>
    withTempDir(async (dir) => {
      const { dataDir, service, prompts, store } = await project(dir);
      await mark(dataDir, "lead");
      await mark(dataDir, "sub1", { lineage: ESessionLineage.Child, parentSessionID: "lead" });
      await mark(dataDir, "sub2", { lineage: ESessionLineage.Child, parentSessionID: "lead" });
      await store.append(read("lead", "AGENTS.md", { agentID: "build", lineage: ESessionLineage.Root }));
      await store.append(read("sub1", "AGENTS.md", { agentID: "explore", lineage: ESessionLineage.Child }));
      await service.reviewProject();
      expect(prompts[0]).toMatch(/AGENTS\.md — read in 2\/3 sessions \(lead 1\/1 · subagent 1\/2\)/);
      expect(prompts[0]).toContain("by agent: build 1 reads in 1 sessions; explore 1 reads in 1 sessions");
      expect(prompts[0]).toContain("1 lead, 2 subagent, 0 of unknown lineage");
    }));

  it("aggregateUsage never lets sessionsRead exceed sessionsTotal", () => {
    const usage = aggregateUsage("a.md", { exists: true, lines: ["x"] }, new Map([["ghost", [read("ghost", "a.md")]]]), []);
    expect(usage).toMatchObject({ sessionsTotal: 1, sessionsRead: 1 });
    expect(usage.byRole[EAgentRole.Unknown]).toEqual({ total: 1, read: 1 });
  });

  it("an estimated read is called out in the prompt", () =>
    withTempDir(async (dir) => {
      const { dataDir, service, prompts, store } = await project(dir);
      await mark(dataDir, "s1");
      await store.append(read("s1", ".ai/doc.md"));
      await service.reviewProject();
      expect(prompts[0]).toContain("1 reads have only requested ranges");
    }));

  it("describeSessionCoverage warns when tracking never started", () => {
    expect(describeSessionCoverage({ total: 0, observed: 0, readsOnly: 0, lead: 0, subagent: 0 })).toContain("has not recorded any session yet");
  });

  it("buildProjectPrompt names the observed/legacy split", () => {
    const usage = aggregateUsage("a.md", { exists: true, lines: ["x"] }, new Map(), [{ sessionID: "s", tracking: ESessionTracking.Observed }]);
    const text = buildProjectPrompt({ sessions: { total: 1, observed: 1, readsOnly: 0, lead: 0, subagent: 0 }, files: [{ usage, content: undefined }] });
    expect(text).toContain("read in 0/1 sessions");
  });
});

describe("ContentBudget", () => {
  const tildeless = (n: number) => "x".repeat(n);

  it("passes a file of exactly the per-file limit through untouched, and truncates one char more", () => {
    const budget = new ContentBudget();
    expect(budget.take(tildeless(MAX_FILE_CONTENT_CHARS))).toBe(tildeless(MAX_FILE_CONTENT_CHARS));
    const over = new ContentBudget().take(tildeless(MAX_FILE_CONTENT_CHARS + 1))!;
    expect(over.length).toBe(MAX_FILE_CONTENT_CHARS);
    expect(over.endsWith(TRUNCATION_MARKER)).toBe(true);
    expect(over.startsWith("xxxx")).toBe(true);
  });

  it("counts the truncation marker toward the per-file limit", () => {
    const body = new ContentBudget(100, 10_000).take(tildeless(500))!;
    expect(body.length).toBe(100);
    expect(body).toBe(tildeless(100 - TRUNCATION_MARKER.length) + TRUNCATION_MARKER);
  });

  it("counts the fence markup toward the total", () => {
    const budget = new ContentBudget(1000, 200);
    const first = budget.take(tildeless(1000))!;
    expect(fence(first).length).toBeLessThanOrEqual(200);
    // Whatever is left cannot hold another file's markup plus a marker.
    expect(budget.take(tildeless(1000))).toBeUndefined();
  });

  it("fills the total budget exactly and no further", () => {
    const markup = fence("").length;
    const budget = new ContentBudget(100, 2 * (100 + markup));
    expect(fence(budget.take(tildeless(100))!).length).toBe(100 + markup);
    expect(fence(budget.take(tildeless(100))!).length).toBe(100 + markup);
    expect(budget.take("y")).toBeUndefined();
  });

  it("shrinks the last file to what is left, marker included", () => {
    const markup = fence("").length;
    const budget = new ContentBudget(1000, 100 + markup + 60 + markup);
    budget.take(tildeless(100));
    const second = budget.take(tildeless(500))!;
    expect(second.length).toBe(60);
    expect(second.endsWith(TRUNCATION_MARKER)).toBe(true);
  });

  it("never exceeds the global limit however many files are offered", () => {
    const budget = new ContentBudget();
    let sent = 0;
    for (let i = 0; i < 100; i++) {
      const body = budget.take(tildeless(1 + ((i * 937) % 12_000)));
      if (body !== undefined) {
        expect(body.length).toBeLessThanOrEqual(MAX_FILE_CONTENT_CHARS);
        sent += fence(body).length;
      }
    }
    expect(sent).toBeLessThanOrEqual(MAX_TOTAL_CONTENT_CHARS);
    expect(sent).toBeGreaterThan(MAX_TOTAL_CONTENT_CHARS - 2 * (MAX_FILE_CONTENT_CHARS + 30));
  });

  it("sends nothing for empty text, and gives up when the room is smaller than the marker", () => {
    expect(new ContentBudget().take("")).toBeUndefined();
    expect(new ContentBudget(5, 1000).take(tildeless(50))).toBeUndefined();
    expect(new ContentBudget(5, 1000).take("abc")).toBe("abc");
  });

  it("does not cut a surrogate pair in half", () => {
    // Room for the marker plus two UTF-16 units: "a" and half of the first emoji.
    const body = new ContentBudget(TRUNCATION_MARKER.length + 2, 1000).take(`a${"😀".repeat(20)}`)!;
    expect(body).toBe(`a${TRUNCATION_MARKER}`);
  });

  it("fences content with more tildes than any run inside it", () => {
    const body = "before\n~~~~~~\ninjected instructions\n~~~~~~\nafter";
    const wrapped = fence(body);
    expect(wrapped).toContain("\n~~~~~~~\nbefore");
    expect(wrapped.endsWith("after\n~~~~~~~\n")).toBe(true);
    const budget = new ContentBudget(1000, wrapped.length);
    expect(budget.take(body)).toBe(body);
  });
});

describe("content budget in the analysis service", () => {
  const blocks = (prompt: string) => (prompt.match(/\nContent:\n(~{4,})\n[\s\S]*?\n\1\n/g) ?? []).map((b) => b.length);

  it("keeps all content blocks of a prompt within the global limit, however many large files there are", () =>
    withTempDir(async (dir) => {
      const docs: Record<string, string> = {};
      for (let i = 0; i < 12; i++) docs[`.ai/f${String(i).padStart(2, "0")}.md`] = `# File ${i}\n${"line of text\n".repeat(900)}`;
      const { service, prompts } = await project(dir, true, docs);
      await service.analyzeSession("s", ["task"]);
      await service.reviewProject();
      for (const prompt of prompts) {
        const sizes = blocks(prompt);
        expect(sizes.length).toBeGreaterThan(1);
        expect(sizes.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(MAX_TOTAL_CONTENT_CHARS);
        for (const size of sizes) expect(size).toBeLessThanOrEqual(MAX_FILE_CONTENT_CHARS + fence("").length + 2);
        expect(prompt).toContain(TRUNCATION_MARKER.trim());
      }
    }));

  it("hands out the budget in path order, regardless of how fast each file loads", () =>
    withTempDir(async (dir) => {
      const docs: Record<string, string> = {};
      for (let i = 0; i < 8; i++) docs[`.ai/f${i}.md`] = `# F${i}\n${`${i}`.repeat(7_000)}\n`;
      const { service, prompts } = await project(dir, true, docs);
      const original = (service as unknown as { coverage: { readLines: (p: string) => Promise<string[] | undefined> } }).coverage;
      const readLines = original.readLines.bind(original);
      let call = 0;
      // Later files load first: a racy implementation would give them the budget.
      original.readLines = async (p) => {
        await new Promise((r) => setTimeout(r, (8 - (call++ % 8)) * 5));
        return readLines(p);
      };
      await service.reviewProject();
      await service.reviewProject();
      expect(prompts[0]).toBe(prompts[1]);
      // Early paths got content, the last ones got outline only.
      expect(prompts[0]).toContain("~~~~\n# F0");
      expect(prompts[0]).not.toContain("# F7\n77777");
    }));

  it("sends no content at all unless includeContent is set", () =>
    withTempDir(async (dir) => {
      const { service, prompts } = await project(dir, false, { ".ai/a.md": "# A\nSECRET\n" });
      await service.reviewProject();
      await service.analyzeSession("s", []);
      expect(prompts.join()).not.toContain("SECRET");
    }));
});
