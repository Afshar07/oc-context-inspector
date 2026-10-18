import { writeFile, mkdir } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import plugin from "../src/index.js";
import { ERevisionState, EVerdict } from "../src/evaluation/types.js";
import { withTempDir } from "./helpers.js";

type Hook = (event: Record<string, unknown>) => unknown;

function fakeContext(directory: string, sessions: Record<string, { parentID?: string }> = {}) {
  const tool: Record<string, Hook> = {};
  const session: Record<string, Hook> = {};
  const rpc = { handlers: {} as Record<string, (input: Record<string, unknown>) => Promise<any>> };
  const ctx = {
    options: {},
    location: { directory },
    generate: { text: async () => ({ text: "" }) },
    model: { default: async () => ({ data: undefined }) },
    tool: { hook: async (name: string, cb: Hook) => void (tool[name] = cb) },
    session: {
      hook: async (name: string, cb: Hook) => void (session[name] = cb),
      get: async ({ sessionID }: { sessionID: string }) => sessions[sessionID] ?? {},
    },
    rpc: {
      register: async (_: unknown, handlers: typeof rpc.handlers) => {
        rpc.handlers = handlers;
        return { dispose: async () => {}, events: { emit: async () => {} } };
      },
    },
  };
  return { ctx: ctx as never, tool, session, rpc };
}

const model = { providerID: "mock", id: "scripted" };
const request = (sessionID: string, messages: { role: string }[] = [{ role: "user" }]) => ({
  sessionID,
  agent: "build",
  model,
  messages,
  system: [],
  tools: {},
  options: {},
});

describe("plugin revision capture", () => {
  it("registers prompt and context hooks, and records a revision for a session that never reads", () =>
    withTempDir(async (dir) => {
      await writeFile(`${dir}/AGENTS.md`, "# Agents\n");
      const { ctx, session, rpc } = fakeContext(dir);
      await plugin.setup(ctx);
      expect(Object.keys(session).sort()).toEqual(["context", "prompt"]);

      await session.prompt!({ sessionID: "s1" });
      await session.context!(request("s1"));
      const revision = await rpc.handlers.sessionRevision!({ sessionID: "s1" });
      expect(revision).toMatchObject({ state: ERevisionState.Stable, models: ["mock/scripted"] });
      expect(revision.startRevisionId).toBe((await rpc.handlers.currentRevision!({})).revisionId);
    }));

  it("sees a change made between two model requests, even within the file-list cache window", () =>
    withTempDir(async (dir) => {
      await mkdir(`${dir}/.ai`);
      await writeFile(`${dir}/AGENTS.md`, "# Agents\n");
      const { ctx, session, tool, rpc } = fakeContext(dir);
      await plugin.setup(ctx);
      await session.context!(request("s1"));
      // The agent creates a new context file with a non-read tool; the next request must see it.
      await writeFile(`${dir}/.ai/new.md`, "x");
      await tool["execute.before"]!({ tool: "write", sessionID: "s1", id: "c1", input: { path: ".ai/new.md", content: "SECRET BODY" } });
      await session.context!(request("s1", [{ role: "user" }, { role: "assistant" }, { role: "tool" }]));
      expect((await rpc.handlers.sessionRevision!({ sessionID: "s1" })).state).toBe(ERevisionState.Mixed);
    }));

  it("marks a session first seen with history as unknown rather than guessing", () =>
    withTempDir(async (dir) => {
      await writeFile(`${dir}/AGENTS.md`, "# Agents\n");
      const { ctx, session, rpc } = fakeContext(dir);
      await plugin.setup(ctx);
      await session.context!(request("late", [{ role: "user" }, { role: "assistant" }]));
      expect(await rpc.handlers.sessionRevision!({ sessionID: "late" })).toMatchObject({ state: ERevisionState.Unknown });
    }));

  it("never mutates the events it observes, and a failing store does not reach the agent", () =>
    withTempDir(async (dir) => {
      await writeFile(`${dir}/package.json`, "{}");
      const { ctx, session, tool } = fakeContext(dir);
      // dataDir below a regular file: every write fails.
      (ctx as unknown as { options: Record<string, unknown> }).options = { dataDir: "package.json/sub" };
      await plugin.setup(ctx);
      const prompt = { sessionID: "s", messageID: "m", prompt: { text: "do it" } };
      const context = request("s");
      const before = JSON.stringify([prompt, context]);
      await expect(Promise.resolve(session.prompt!(prompt))).resolves.toBeUndefined();
      await expect(Promise.resolve(session.context!(context))).resolves.toBeUndefined();
      expect(JSON.stringify([prompt, context])).toBe(before);
      const input = { path: "AGENTS.md", content: "x" };
      await expect(Promise.resolve(tool["execute.before"]!({ tool: "write", sessionID: "s", id: "c", input }))).resolves.toBeUndefined();
      expect(input).toEqual({ path: "AGENTS.md", content: "x" });
    }));

  it("keeps working when the runtime has no prompt hook", () =>
    withTempDir(async (dir) => {
      await writeFile(`${dir}/AGENTS.md`, "# Agents\n");
      const { ctx, session, rpc } = fakeContext(dir);
      const original = (ctx as unknown as { session: { hook: (name: string, cb: Hook) => Promise<void> } }).session.hook;
      (ctx as unknown as { session: { hook: unknown } }).session.hook = async (name: string, cb: Hook) => {
        if (name === "prompt") throw new Error("unsupported");
        return original(name, cb);
      };
      await plugin.setup(ctx);
      await session.context!(request("s"));
      expect((await rpc.handlers.sessionRevision!({ sessionID: "s" })).state).toBe(ERevisionState.Stable);
    }));
});

describe("plugin experiment RPC", () => {
  it("runs the whole workflow through the RPC handlers without touching documentation", () =>
    withTempDir(async (dir) => {
      await mkdir(`${dir}/.ai`);
      await writeFile(`${dir}/AGENTS.md`, "# Agents\n");
      await writeFile(`${dir}/.ai/style.md`, "# Style\nold\n");
      const { ctx, session, tool, rpc } = fakeContext(dir);
      await plugin.setup(ctx);
      const h = rpc.handlers;

      const run = async (id: string, read: boolean) => {
        await session.prompt!({ sessionID: id });
        await session.context!(request(id));
        if (read) {
          const input = { path: ".ai/style.md" };
          await tool["execute.before"]!({ tool: "read", sessionID: id, id: "c1", input });
          await tool["execute.after"]!({ tool: "read", sessionID: id, id: "c1", input, status: "completed" });
        }
      };

      for (const id of ["b1", "b2", "b3"]) await run(id, false);
      const created = await h.createExperiment!({ name: "Style", hypothesis: "Agents read style", targetFiles: [".ai/style.md"], baselineSessionIDs: ["b1", "b2", "b3"] });
      expect(created).toMatchObject({ ok: true, experiment: { status: "awaiting-candidate" } });
      const id = created.experiment.id as string;
      expect(await h.createExperiment!({ name: "style", hypothesis: "x", targetFiles: [".ai/style.md"] })).toMatchObject({ ok: false });

      expect(await h.detectCandidate!({ id })).toMatchObject({ ok: true, detection: { changed: false } });
      await writeFile(`${dir}/.ai/style.md`, "# Style\nnew\n");
      const detection = (await h.detectCandidate!({ id })).detection;
      expect(detection.changed).toBe(true);
      expect(await h.confirmCandidate!({ id, revisionId: detection.revisionId })).toMatchObject({ ok: true, experiment: { status: "measuring" } });

      for (const sid of ["c1", "c2", "c3"]) await run(sid, true);
      const offers = (await h.experimentSessions!({ id })).offers as { sessionID: string; fit: string }[];
      expect(offers.filter((o) => o.fit === "candidate").map((o) => o.sessionID)).toEqual(["c1", "c2", "c3"]);
      await h.setExperimentSessions!({ id, add: ["c1", "c2", "c3"].map((sessionID) => ({ sessionID, role: "candidate" })) });

      const evaluated = await h.evaluateExperiment!({ id });
      expect(evaluated.ok).toBe(true);
      expect(evaluated.result.verdict).toMatchObject({ verdict: EVerdict.Inconclusive, discovery: EVerdict.Improved, improved: ["discovery.explicit-read"] });

      const listed = await h.listExperiments!({});
      expect(listed.experiments).toHaveLength(1);
      expect(listed.experiments[0].evaluations).toHaveLength(1);
      expect(await h.closeExperiment!({ id, reason: "done" })).toMatchObject({ ok: true, experiment: { status: "closed" } });
      expect(await h.confirmCandidate!({ id, revisionId: "x" })).toMatchObject({ ok: false });
      // The user's documentation is exactly what the user wrote.
      const { readFile } = await import("node:fs/promises");
      expect(await readFile(`${dir}/.ai/style.md`, "utf8")).toBe("# Style\nnew\n");
    }));

  it("reports user mistakes as plain failures and faults with a prefix", () =>
    withTempDir(async (dir) => {
      await writeFile(`${dir}/AGENTS.md`, "# Agents\n");
      const { ctx, rpc } = fakeContext(dir);
      await plugin.setup(ctx);
      expect(await rpc.handlers.closeExperiment!({ id: "nope" })).toEqual({ ok: false, error: "Unknown experiment: nope" });
    }));
});
