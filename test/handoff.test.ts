import { describe, expect, it } from "vitest";
import { summarize } from "../src/coverage.js";
import { handoffMessage } from "../src/tui/handoff.js";
import { EReadStatus } from "../src/types.js";

const read = summarize(
  ".ai/a.md",
  [
    {
      sessionID: "s",
      callID: "c",
      tool: "read",
      filePath: ".ai/a.md",
      matchedPattern: ".ai/**",
      requestedRange: { offset: 10, limit: 20 },
      status: EReadStatus.Completed,
      startedAt: "2026-01-01T00:00:00.000Z",
      completedAt: "2026-01-01T00:00:00.000Z",
    },
  ],
  { exists: true, lineCount: 120 },
  false,
);
const unread = summarize(".ai/b.md", [], { exists: true, lineCount: 5 }, false);

describe("handoffMessage", () => {
  it("carries the session review, its model and the read data, and tells the agent to wait", () => {
    const text = handoffMessage({ mode: "session", answer: "**Verdict**: fine", model: "p/m", files: [read, unread] });
    expect(text).toContain("**Verdict**: fine");
    expect(text).toContain("p/m");
    expect(text).toMatch(/wait for the user's instructions/i);
    expect(text).toContain("◐ .ai/a.md — L10–29/120");
    expect(text).toContain("○ .ai/b.md");
  });

  it("describes a project review by its session count, without per-session read data", () => {
    const text = handoffMessage({ mode: "project", answer: "Merge X", model: "p/m", sessionCount: 4, files: [] });
    expect(text).toContain("4 recorded sessions");
    expect(text).toContain("Merge X");
    expect(text).not.toContain("## Context reads");
  });
});
