import { mkdir, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { CoverageService } from "../src/coverage.js";
import { EvaluationService } from "../src/evaluation/evaluate.js";
import { ExperimentService, type ICreateExperimentInput } from "../src/evaluation/experiments.js";
import { GroupResolver } from "../src/evaluation/groups.js";
import { RevisionSnapshotter } from "../src/evaluation/revisions.js";
import { SessionRevisionTracker, type ISessionRevisionEvent } from "../src/evaluation/session-revisions.js";
import { EvaluationStore } from "../src/evaluation/store.js";
import { ContextPathMatcher, DEFAULT_CONTEXT_PATHS } from "../src/matcher.js";
import { SessionRegistry } from "../src/sessions.js";
import { JsonlContextReadStore, writeSessionMarker } from "../src/store.js";
import { EDeliverySource, EReadStatus, ESessionLineage, type IContextReadRecord, type IDeliveredRead } from "../src/types.js";
import { StepClock } from "./helpers.js";

/** A project directory with the evaluation services wired against it. Files are written by the test. */
export function makeHarness(root: string, options: { autoLoaded?: readonly string[]; environment?: string } = {}) {
  const dataDir = path.join(root, ".opencode", "context-inspector");
  const matcher = new ContextPathMatcher(root, DEFAULT_CONTEXT_PATHS);
  const registry = new SessionRegistry(dataDir);
  const autoLoaded = options.autoLoaded ?? ["AGENTS.md"];
  const coverage = new CoverageService(root, matcher, { dataDir, autoLoaded }, registry);
  const store = new EvaluationStore(dataDir);
  const clock = new StepClock();
  // No list caching: tests edit files between calls.
  const snapshotter = new RevisionSnapshotter(root, () => coverage.listContextFiles(), { listTtlMs: 0, clock });
  const groups = new GroupResolver(registry, store);
  let counter = 0;
  const experiments = new ExperimentService({ store, snapshotter, matcher, groups, clock, newId: () => `exp_${++counter}` });
  const evaluation = new EvaluationService({ experiments, groups, store, dataDir, autoLoaded, clock });
  const tracker = new SessionRevisionTracker(store, snapshotter, options.environment ?? "env1", clock);
  const reads = new JsonlContextReadStore(dataDir);
  let call = 0;

  return {
    root,
    dataDir,
    store,
    snapshotter,
    groups,
    experiments,
    evaluation,
    tracker,
    registry,
    clock,
    /** Writes (or replaces) a project file. */
    async write(rel: string, text: string) {
      const abs = path.join(root, rel);
      await mkdir(path.dirname(abs), { recursive: true });
      await writeFile(abs, text);
    },
    /** Makes the registry aware of a session, as the observer would. */
    async mark(sessionID: string, parentSessionID?: string) {
      await writeSessionMarker(dataDir, {
        version: 1,
        sessionID,
        firstObservedAt: clock.now().toISOString(),
        lineage: parentSessionID ? ESessionLineage.Child : ESessionLineage.Root,
        ...(parentSessionID && { parentSessionID }),
      });
    },
    /** A clean session start as the hooks report it: observed, first request without history. */
    async start(sessionID: string, parentSessionID?: string, extra: Partial<ISessionRevisionEvent> = {}) {
      await this.mark(sessionID, parentSessionID);
      await tracker.observe({ sessionID, source: "context", priorTurns: false, model: "mock/scripted", agent: "build", ...extra });
    },
    /** A later model request of an already running session. */
    async request(sessionID: string, extra: Partial<ISessionRevisionEvent> = {}) {
      await tracker.observe({ sessionID, source: "context", priorTurns: true, model: "mock/scripted", agent: "build", ...extra });
    },
    async read(sessionID: string, filePath: string, extra: Partial<IContextReadRecord> = {}) {
      const n = ++call;
      const at = new Date(Date.UTC(2026, 0, 1, 0, 0, n * 2)).toISOString();
      await reads.append({
        sessionID,
        callID: `c${n}`,
        tool: "read",
        filePath,
        matchedPattern: "AGENTS.md",
        requestedRange: {},
        status: EReadStatus.Completed,
        startedAt: at,
        completedAt: new Date(Date.UTC(2026, 0, 1, 0, 0, n * 2 + 1)).toISOString(),
        ...extra,
      });
    },
    async create(input: Partial<ICreateExperimentInput> = {}) {
      return experiments.create({
        name: "Clarify routing",
        hypothesis: "A routing table makes agents read style.md first",
        targetFiles: [".ai/style.md"],
        ...input,
      });
    },
  };
}

export type Harness = ReturnType<typeof makeHarness>;

/** A delivery record for a whole small file. */
export const wholeFile = (lines: number): IDeliveredRead => ({
  source: EDeliverySource.Header,
  lineCount: lines,
  ...(lines > 0 && { range: { start: 1, end: lines } }),
  reachedEof: true,
  fileLines: lines,
});

export async function seedProject(h: Harness) {
  await h.write("AGENTS.md", "# Agents\nRead .ai/style.md\n");
  await h.write(".ai/style.md", "# Style\nUse tabs\n");
  await h.write(".ai/architecture.md", "# Architecture\n");
}
