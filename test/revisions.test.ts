import { rm } from "node:fs/promises";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
  classifySessionRevision,
  diffSnapshots,
  makeSnapshot,
  restrictDiff,
  revisionId,
  scopedRevisionId,
} from "../src/evaluation/revisions.js";
import { ERevisionCapture, ERevisionState, EVALUATION_SCHEMA_VERSION, type IFileHash } from "../src/evaluation/types.js";
import { makeHarness, seedProject } from "./evaluation-helpers.js";
import { withTempDir } from "./helpers.js";

const file = (p: string, sha: string): IFileHash => ({ path: p, sha256: sha, sizeBytes: 1 });

describe("revision ids", () => {
  it("is the same for the same files whatever order or path separators they arrive in", () => {
    const a = revisionId([file("b.md", "2"), file("a.md", "1")]);
    expect(revisionId([file("a.md", "1"), file("b.md", "2")])).toBe(a);
    expect(revisionId([file("a.md", "1"), file(String.raw`b.md`, "2")])).toBe(a);
    expect(makeSnapshot([file(String.raw`.ai\x.md`, "1")], "t").files[0]!.path).toBe(".ai/x.md");
  });

  it("orders by code point, not by locale", () => {
    expect(makeSnapshot([file("b", "1"), file("B", "1"), file("a", "1")], "t").files.map((f) => f.path)).toEqual(["B", "a", "b"]);
  });

  it("changes when content changes, a file is added, or a file is deleted", () => {
    const base = [file("a.md", "1"), file("b.md", "2")];
    const id = revisionId(base);
    expect(revisionId([file("a.md", "1"), file("b.md", "3")])).not.toBe(id);
    expect(revisionId([...base, file("c.md", "4")])).not.toBe(id);
    expect(revisionId([file("a.md", "1")])).not.toBe(id);
  });

  it("scopes to given paths, so another file's change does not move it, but a missing target does", () => {
    const before = [file("a.md", "1"), file("b.md", "2")];
    const after = [file("a.md", "1"), file("b.md", "9")];
    expect(scopedRevisionId(before, ["a.md"])).toBe(scopedRevisionId(after, ["a.md"]));
    expect(scopedRevisionId(before, ["b.md"])).not.toBe(scopedRevisionId(after, ["b.md"]));
    expect(scopedRevisionId(before, ["b.md"])).not.toBe(scopedRevisionId([file("a.md", "1")], ["b.md"]));
  });
});

describe("diffSnapshots", () => {
  const snap = (...files: IFileHash[]) => makeSnapshot(files, "t");

  it("reports added, removed and modified paths", () => {
    const diff = diffSnapshots(snap(file("a", "1"), file("b", "2")), snap(file("a", "9"), file("c", "3")));
    expect(diff).toEqual({ added: ["c"], removed: ["b"], modified: ["a"], renamed: [] });
  });

  it("detects a rename as identical content under a new path", () => {
    const diff = diffSnapshots(snap(file("old.md", "7")), snap(file("new.md", "7")));
    expect(diff).toEqual({ added: [], removed: [], modified: [], renamed: [{ from: "old.md", to: "new.md" }] });
  });

  it("does not call a rename when the content also changed", () => {
    const diff = diffSnapshots(snap(file("old.md", "7")), snap(file("new.md", "8")));
    expect(diff.renamed).toEqual([]);
    expect(diff.added).toEqual(["new.md"]);
    expect(diff.removed).toEqual(["old.md"]);
  });

  it("pairs duplicate content one to one in path order", () => {
    const diff = diffSnapshots(snap(file("a", "7"), file("b", "7")), snap(file("x", "7"), file("y", "7")));
    expect(diff.renamed).toEqual([{ from: "a", to: "x" }, { from: "b", to: "y" }]);
  });

  it("restricts to a path set", () => {
    const diff = diffSnapshots(snap(file("a", "1"), file("b", "1")), snap(file("a", "2"), file("b", "2")));
    expect(restrictDiff(diff, new Set(["a"])).modified).toEqual(["a"]);
  });
});

describe("RevisionSnapshotter", () => {
  it("gives two sessions on identical files the same revision, and a content change a new one", async () => {
    await withTempDir(async (dir) => {
      const h = makeHarness(dir);
      await seedProject(h);
      const a = await h.snapshotter.current();
      const b = await h.snapshotter.current();
      expect(b.id).toBe(a.id);
      expect(a.files.map((f) => f.path)).toEqual([".ai/architecture.md", ".ai/style.md", "AGENTS.md"]);

      await h.write(".ai/style.md", "# Style\nUse spaces\n");
      expect((await h.snapshotter.current()).id).not.toBe(a.id);
    });
  });

  it("stores hashes and sizes, never contents", async () => {
    await withTempDir(async (dir) => {
      const h = makeHarness(dir);
      await seedProject(h);
      const snapshot = await h.snapshotter.current();
      expect(JSON.stringify(snapshot)).not.toContain("Use tabs");
      expect(snapshot.files.every((f) => /^[0-9a-f]{64}$/.test(f.sha256))).toBe(true);
    });
  });

  it("notices added and deleted files", async () => {
    await withTempDir(async (dir) => {
      const h = makeHarness(dir);
      await seedProject(h);
      const base = await h.snapshotter.current();
      await h.write(".ai/new.md", "x");
      const added = await h.snapshotter.current();
      expect(diffSnapshots(base, added).added).toEqual([".ai/new.md"]);
      await rm(path.join(dir, ".ai/style.md"));
      const deleted = await h.snapshotter.current();
      expect(diffSnapshots(added, deleted).removed).toEqual([".ai/style.md"]);
    });
  });

  it("works without Git and ignores the plugin's own data", async () => {
    await withTempDir(async (dir) => {
      const h = makeHarness(dir);
      await seedProject(h);
      await h.write(".opencode/context-inspector/evaluation/x.json", "{}");
      expect((await h.snapshotter.current()).files.some((f) => f.path.includes("context-inspector"))).toBe(false);
    });
  });

  it("shares one run between concurrent callers", async () => {
    await withTempDir(async (dir) => {
      const h = makeHarness(dir);
      await seedProject(h);
      const [a, b] = await Promise.all([h.snapshotter.current(), h.snapshotter.current()]);
      expect(a).toBe(b);
    });
  });
});

describe("classifySessionRevision", () => {
  const base = {
    version: EVALUATION_SCHEMA_VERSION,
    sessionID: "s",
    firstSeenAt: "t",
    models: [],
    agents: [],
  } as const;

  it("is unknown without a record", () => {
    expect(classifySessionRevision("s", undefined).state).toBe(ERevisionState.Unknown);
  });

  it("is unknown for a session first seen after it started, even if it later agrees", () => {
    const late = classifySessionRevision("s", { ...base, capture: ERevisionCapture.Late, observed: [{ at: "t", revisionId: "r1" }] });
    expect(late.state).toBe(ERevisionState.Unknown);
    expect(late.startRevisionId).toBeUndefined();
  });

  it("is stable with one revision and mixed with two", () => {
    const stable = classifySessionRevision("s", { ...base, capture: ERevisionCapture.FirstRequest, startRevisionId: "r1", observed: [{ at: "t", revisionId: "r1" }] });
    expect(stable).toMatchObject({ state: ERevisionState.Stable, startRevisionId: "r1" });
    const mixed = classifySessionRevision("s", {
      ...base,
      capture: ERevisionCapture.FirstRequest,
      startRevisionId: "r1",
      observed: [{ at: "t", revisionId: "r1" }, { at: "u", revisionId: "r2" }],
    });
    expect(mixed).toMatchObject({ state: ERevisionState.Mixed, revisionIds: ["r1", "r2"] });
  });
});
