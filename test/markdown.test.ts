import { describe, expect, it } from "vitest";
import { parseInline, parseMarkdown } from "../src/tui/markdown-parse.js";

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
