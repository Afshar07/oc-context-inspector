import { describe, expect, it } from "vitest";
import { isMarkdownPath, parseInline, parseMarkdown, parseSourceLines } from "../src/tui/markdown-parse.js";

describe("parseInline", () => {
  it("splits bold, italic and code spans and drops their markers", () => {
    expect(parseInline("a **b** *c* `d` e")).toEqual([
      { text: "a " },
      { text: "b", bold: true },
      { text: " " },
      { text: "c", italic: true },
      { text: " " },
      { text: "d", code: true },
      { text: " e" },
    ]);
  });

  it("keeps markers that never close, and does not style inside code", () => {
    expect(parseInline("2 * 3 and **open")).toEqual([{ text: "2 * 3 and **open" }]);
    expect(parseInline("`**x**`")).toEqual([{ text: "**x**", code: true }]);
  });

  it("treats a bold span holding code as bold text without backticks", () => {
    expect(parseInline("**`a.md`** (0/2)")).toEqual([{ text: "a.md", bold: true }, { text: " (0/2)" }]);
  });
});

describe("parseMarkdown", () => {
  it("recognizes headings, lists, paragraphs, code and blank lines", () => {
    const blocks = parseMarkdown(["## Gaps", "- one", "  - nested", "1. first", "plain", "", "```", "- not a list", "```"].join("\n"));
    expect(blocks.map((b) => [b.kind, "level" in b ? b.level : undefined, "marker" in b ? b.marker : undefined])).toEqual([
      ["heading", 2, undefined],
      ["item", 0, "•"],
      ["item", 1, "•"],
      ["item", 0, "1."],
      ["paragraph", undefined, undefined],
      ["blank", undefined, undefined],
      ["code", undefined, undefined],
    ]);
    expect(blocks.at(-1)).toEqual({ kind: "code", lines: ["- not a list"] });
  });
});

describe("parseSourceLines", () => {
  it("keeps one entry per line and styles by kind, treating fenced lines as code", () => {
    const lines = ["# Title", "- a `b`", "  2. two", "> quote", "```ts", "- not a list", "```", "plain **x**", ""];
    const parsed = parseSourceLines(lines);
    expect(parsed).toHaveLength(lines.length);
    expect(parsed.map((l) => l.kind)).toEqual(["heading", "item", "item", "quote", "fence", "code", "fence", "text", "text"]);
    expect(parsed[0]).toEqual({ kind: "heading", prefix: "", inlines: [{ text: "Title" }] });
    expect(parsed[1]).toEqual({ kind: "item", prefix: "- ", inlines: [{ text: "a " }, { text: "b", code: true }] });
    expect(parsed[5]!.inlines).toEqual([{ text: "- not a list" }]);
    expect(parsed[7]!.inlines).toEqual([{ text: "plain " }, { text: "x", bold: true }]);
  });

  it("detects Markdown paths", () => {
    expect(isMarkdownPath(".ai/README.md")).toBe(true);
    expect(isMarkdownPath("a/b.MDX")).toBe(true);
    expect(isMarkdownPath("a/b.json")).toBe(false);
  });
});
