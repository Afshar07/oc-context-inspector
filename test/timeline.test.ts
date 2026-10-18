import { describe, expect, it } from "vitest";
import { buildTimeline, MAX_TIMELINE_EVENTS, toProjectPath } from "../src/tui/timeline.js";
import { ETimelineKind } from "../src/types.js";

const DIR = "D:\\proj";
const user = (ms: number, text: string) => ({ id: `u${ms}`, type: "user", time: { created: ms }, text });
const assistant = (ms: number, agent: string, tools: readonly unknown[]) => ({
  id: `a${ms}`,
  type: "assistant",
  agent,
  time: { created: ms },
  content: [{ type: "text", text: "hi" }, ...tools],
});
const tool = (id: string, name: string, ms: number, state: unknown) => ({ type: "tool", id, name, time: { created: ms }, state });

describe("toProjectPath", () => {
  it("makes absolute and relative paths project-relative POSIX, and drops outsiders", () => {
    expect(toProjectPath("D:\\proj\\.ai\\a.md", DIR)).toBe(".ai/a.md");
    expect(toProjectPath("d:/PROJ/.ai/a.md", DIR)).toBe(".ai/a.md");
    expect(toProjectPath("./src/x.ts", DIR)).toBe("src/x.ts");
    expect(toProjectPath("/etc/passwd", "/home/me/proj")).toBeUndefined();
    expect(toProjectPath("/home/me/proj/a.md", "/home/me/proj")).toBe("a.md");
    expect(toProjectPath("../other/a.md", DIR)).toBeUndefined();
    expect(toProjectPath("D:\\projother\\a.md", DIR)).toBeUndefined();
  });
});

describe("buildTimeline", () => {
  it("orders user steps, tool calls, shell commands and subagent steps by time", () => {
    const lead = [
      user(1000, "fix the build"),
      assistant(2000, "build", [
        tool("c1", "read", 2100, { status: "completed", input: { path: "D:\\proj\\AGENTS.md" } }),
        tool("c2", "edit", 2900, { status: "error", input: { filePath: "src/a.ts" }, error: { type: "x", message: "no match" } }),
      ]),
      { type: "shell", time: { created: 4000 }, command: "npm test\nsecond line", status: "exited", exit: 1 },
    ];
    const sub = [assistant(2500, "explore", [tool("s1", "grep", 2600, { status: "completed", input: { pattern: "x" } })])];
    const { events, omitted } = buildTimeline(
      [
        { sessionID: "lead", messages: lead },
        { sessionID: "child", messages: sub },
      ],
      DIR,
    );
    expect(omitted).toBe(0);
    expect(events.map((e) => [e.sessionID, e.kind, e.tool ?? e.command ?? e.text])).toEqual([
      ["lead", ETimelineKind.User, "fix the build"],
      ["lead", ETimelineKind.Tool, "read"],
      ["child", ETimelineKind.Tool, "grep"],
      ["lead", ETimelineKind.Tool, "edit"],
      ["lead", ETimelineKind.Shell, "npm test"],
    ]);
    expect(events[1]).toMatchObject({ agentID: "build", path: "AGENTS.md", callID: "c1", status: "completed" });
    expect(events[3]).toMatchObject({ status: "error", path: "src/a.ts", text: "no match" });
    expect(events[4]).toMatchObject({ exit: 1 });
  });

  it("copies primitives only: tool input and content never leak", () => {
    const secret = "TOKEN=sk-live-123";
    const { events } = buildTimeline(
      [
        {
          sessionID: "s",
          messages: [
            assistant(1, "build", [
              tool("c", "write", 2, { status: "completed", input: { path: "a.ts", content: secret }, content: [{ text: secret }] }),
            ]),
          ],
        },
      ],
      DIR,
    );
    expect(JSON.stringify(events)).not.toContain(secret);
  });

  it("skips unknown or malformed messages instead of throwing", () => {
    const { events } = buildTimeline(
      [{ sessionID: "s", messages: [null, 3, { type: "weird" }, { type: "assistant", content: "nope" }, { type: "user", text: "  " }] }],
      DIR,
    );
    expect(events).toEqual([]);
  });

  it("truncates long user text, error text and commands", () => {
    const { events } = buildTimeline(
      [
        {
          sessionID: "s",
          messages: [user(1, "x".repeat(1000)), { type: "shell", time: { created: 2 }, command: "y".repeat(500), status: "exited", exit: 0 }],
        },
      ],
      DIR,
    );
    expect(events[0]!.text!.length).toBe(300);
    expect(events[1]!.command!.length).toBe(120);
  });

  it("caps events, dropping plain tool steps before reads, errors and user messages", () => {
    const noise = Array.from({ length: MAX_TIMELINE_EVENTS + 20 }, (_, i) => tool(`n${i}`, "grep", 100 + i, { status: "completed", input: {} }));
    const { events, omitted } = buildTimeline(
      [
        {
          sessionID: "s",
          messages: [
            user(1, "task"),
            assistant(50, "build", [tool("r", "read", 60, { status: "completed", input: { path: "AGENTS.md" } })]),
            assistant(99, "build", noise),
          ],
        },
      ],
      DIR,
    );
    expect(events).toHaveLength(MAX_TIMELINE_EVENTS);
    expect(omitted).toBe(22);
    expect(events.some((e) => e.kind === ETimelineKind.User)).toBe(true);
    expect(events.some((e) => e.tool === "read")).toBe(true);
  });
});
