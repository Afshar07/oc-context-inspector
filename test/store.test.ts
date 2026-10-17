import { readdir, readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { JsonlContextReadStore, readSessionRecords } from "../src/store.js";
import { EReadStatus, type IContextReadRecord } from "../src/types.js";
import { withTempDir } from "./helpers.js";

const record = (sessionID: string, callID: string, filePath = "AGENTS.md"): IContextReadRecord => ({
  sessionID,
  callID,
  tool: "read",
  filePath,
  matchedPattern: "AGENTS.md",
  requestedRange: {},
  status: EReadStatus.Completed,
  startedAt: "2026-01-01T00:00:00.000Z",
  completedAt: "2026-01-01T00:00:01.000Z",
});

describe("JsonlContextReadStore", () => {
  it("writes one file per session and reads each back in order", () =>
    withTempDir(async (dir) => {
      const store = new JsonlContextReadStore(dir);
      await Promise.all([
        store.append(record("A", "1")),
        store.append(record("B", "1")),
        store.append(record("A", "2")),
      ]);
      expect((await readdir(dir)).sort()).toEqual(["A.jsonl", "B.jsonl"]);
      expect((await readSessionRecords(dir, "A")).map((r) => r.callID).sort()).toEqual(["1", "2"]);
      expect(await readSessionRecords(dir, "B")).toHaveLength(1);
      expect(await readSessionRecords(dir, "nope")).toEqual([]);
    }));

  it("stores metadata only", () =>
    withTempDir(async (dir) => {
      await new JsonlContextReadStore(dir).append(record("A", "1"));
      const keys = Object.keys(JSON.parse((await readFile(`${dir}/A.jsonl`, "utf8")).trim()));
      expect(keys).not.toContain("content");
      expect(keys).not.toContain("output");
    }));

  it("cannot escape the data directory through the session ID", () =>
    withTempDir(async (dir) => {
      await new JsonlContextReadStore(dir).append(record("../../evil", "1"));
      expect(await readdir(dir)).toEqual(["______evil.jsonl"]);
    }));
});
