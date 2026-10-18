// Service-level checks on the data a real OpenCode run produced (see e2e/run.sh). Skipped unless
// E2E_PROJECT_DIR points at the e2e project; e2e/run.sh sets it, `npm test` alone does not.
import { readFile, readdir } from "node:fs/promises";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { AnalysisService } from "../src/analysis.js";
import { CoverageService } from "../src/coverage.js";
import { ContextPathMatcher, DEFAULT_CONTEXT_PATHS } from "../src/matcher.js";
import { ECoverageCertainty, ECoverageStatus, EAgentRole, ESessionTracking, type IContextReadRecord } from "../src/types.js";

const projectDir = process.env.E2E_PROJECT_DIR;

describe.skipIf(!projectDir)("data recorded by a real OpenCode run", () => {
  const dir = projectDir ?? "";
  const dataDir = path.join(dir, ".opencode/context-inspector");

  /** scenario letter -> session ID, from the call IDs the scripted LLM issued. */
  async function sessions(): Promise<Map<string, string>> {
    const map = new Map<string, string>();
    for (const name of (await readdir(dataDir)).filter((n) => n.endsWith(".jsonl"))) {
      const first = (await readFile(path.join(dataDir, name), "utf8")).split("\n")[0]!;
      const record = JSON.parse(first) as IContextReadRecord;
      map.set(/^call_SCENARIO-([A-Z])_/.exec(record.callID)![1]!, record.sessionID);
    }
    return map;
  }

  const coverage = () =>
    new CoverageService(dir, new ContextPathMatcher(dir, DEFAULT_CONTEXT_PATHS), { dataDir, autoLoaded: ["AGENTS.md"] });
  const file = async (scenario: string, filePath: string) => {
    const id = (await sessions()).get(scenario)!;
    return (await coverage().coverage(id)).files.find((f) => f.filePath === filePath)!;
  };

  it("reports confirmed, delivered-line coverage for the edge-case session", async () => {
    expect(await file("C", ".ai/long.md")).toMatchObject({
      status: ECoverageStatus.Full,
      certainty: ECoverageCertainty.Confirmed,
      ranges: [{ start: 1, end: 2500 }],
      lineCount: 2500,
      readCount: 3,
    });
    expect(await file("C", ".ai/empty.md")).toMatchObject({ status: ECoverageStatus.Full, certainty: ECoverageCertainty.Confirmed, lineCount: 0 });
    expect(await file("C", ".ai/short.md")).toMatchObject({ status: ECoverageStatus.Error, errorCount: 1 });
  });

  it("tells partial from full coverage and repeated reads from first reads", async () => {
    expect(await file("A", ".ai/architecture.md")).toMatchObject({
      status: ECoverageStatus.Partial,
      certainty: ECoverageCertainty.Confirmed,
      ranges: [{ start: 10, end: 39 }],
      lineCount: 60,
      readCount: 3,
      repeatReads: 1,
    });
    expect(await file("A", "AGENTS.md")).toMatchObject({ status: ECoverageStatus.Full, repeatReads: 1, readCount: 2 });
    expect(await file("A", ".ai/missing.md")).toMatchObject({ status: ECoverageStatus.Error, exists: false });
  });

  it("keeps the lead's status to its own reads and lists the subagent apart", async () => {
    const style = await file("E", ".ai/style.md");
    expect(style).toMatchObject({ status: ECoverageStatus.Partial, ranges: [{ start: 1, end: 3 }] });
    const agents = await file("E", "AGENTS.md");
    // The lead never read AGENTS.md itself (OpenCode injects it); the subagent did.
    expect(agents.status).toBe(ECoverageStatus.AutoLoaded);
    expect(agents.agents.map((a) => [a.role, a.depth])).toEqual([[EAgentRole.Subagent, 1]]);
    const arch = await file("E", ".ai/architecture.md");
    expect(arch.agents.map((a) => [a.role, a.depth])).toEqual([[EAgentRole.Subagent, 1]]);
    // Seen from the subagent itself, its reads are its own, not delegated.
    expect((await file("S", "AGENTS.md")).agents.map((a) => a.depth)).toEqual([0]);
  });

  it("counts all eight observed sessions, including those that read no context", async () => {
    const prompts: string[] = [];
    const service = new AnalysisService(coverage(), dataDir, async (p) => (prompts.push(p), "ANSWER"), { includeContent: false });
    expect(await service.reviewProject()).toMatchObject({ sessionCount: 8, readsOnlySessions: 0 });
    const prompt = prompts[0]!;
    expect(prompt).toMatch(/AGENTS\.md — read in 3\/8 sessions \(lead 2\/6 · subagent 1\/2\)/);
    expect(prompt).toMatch(/\.ai\/architecture\.md — read in 2\/8 sessions/);
    expect(prompt).toMatch(/\.ai\/style\.md — read in 2\/8 sessions/);
    expect(prompt).toContain("8 sessions: 6 lead, 2 subagent");
    expect(prompt).toContain("8 were observed running");
  });

  it("knows a session it never saw is unobserved", async () => {
    expect((await coverage().coverage("ses_never_seen")).tracking).toBe(ESessionTracking.Unobserved);
  });
});
