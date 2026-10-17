import { describe, expect, it } from "vitest";
import { ContextPathMatcher, DEFAULT_CONTEXT_PATHS } from "../src/matcher.js";
import { ROOT } from "./helpers.js";

const matcher = new ContextPathMatcher(ROOT, DEFAULT_CONTEXT_PATHS);

describe("ContextPathMatcher", () => {
  it.each([
    ["AGENTS.md", "AGENTS.md"],
    [`${ROOT}/AGENTS.md`, "AGENTS.md"],
    ["packages/api/AGENTS.md", "AGENTS.md"],
    [".ai/architecture.md", ".ai/**"],
    [".ai/deep/nested/rules.md", ".ai/**"],
    [".ai", ".ai/**"],
  ])("matches %s", (input, pattern) => {
    expect(matcher.match(input)?.pattern).toBe(pattern);
  });

  it.each(["src/app.ts", "README.md", "docs/.ai/x.md", "AGENTS.md.bak", "../AGENTS.md", "/etc/AGENTS.md"])(
    "ignores %s",
    (input) => {
      expect(matcher.match(input)).toBeUndefined();
    },
  );

  it("normalizes to project-relative POSIX paths", () => {
    expect(matcher.match("./.ai/../.ai/a.md")?.relPath).toBe(".ai/a.md");
  });

  it("supports custom globs", () => {
    const custom = new ContextPathMatcher(ROOT, ["docs/*.md", "CLAUDE.md"]);
    expect(custom.match("docs/guide.md")).toBeDefined();
    expect(custom.match("docs/a/guide.md")).toBeUndefined();
    expect(custom.match("sub/CLAUDE.md")).toBeDefined();
  });
});
