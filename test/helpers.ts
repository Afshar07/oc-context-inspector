import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { ContextPathMatcher, DEFAULT_CONTEXT_PATHS } from "../src/matcher.js";
import { ContextReadTracker } from "../src/tracker.js";
import type { IClock, IContextReadRecord, IContextReadStore } from "../src/types.js";

export const ROOT = path.resolve("/work/project");

export class MemoryStore implements IContextReadStore {
  readonly records: IContextReadRecord[] = [];
  async append(record: IContextReadRecord): Promise<void> {
    this.records.push(record);
  }
}

export class StepClock implements IClock {
  private tick = 0;
  now(): Date {
    return new Date(Date.UTC(2026, 0, 1, 0, 0, this.tick++));
  }
}

export function makeTracker(
  store: IContextReadStore,
  contextPaths: readonly string[] = DEFAULT_CONTEXT_PATHS,
): ContextReadTracker {
  return new ContextReadTracker(
    new ContextPathMatcher(ROOT, contextPaths),
    new Set(["read"]),
    store,
    new StepClock(),
  );
}

export async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(tmpdir(), "ctx-inspector-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
