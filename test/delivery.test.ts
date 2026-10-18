import { describe, expect, it } from "vitest";
import { parseDelivery } from "../src/delivery.js";
import { EDeliverySource } from "../src/types.js";

const text = (header: string, body = "") => [{ type: "text", text: `${header}\n${body}` }];

describe("parseDelivery", () => {
  it("reads the delivered range from the result header", () => {
    const result = {
      output: { type: "text-page", content: "x", offset: 10, truncated: true, next: 30 },
      content: text("Read file .ai/architecture.md, lines 10-29", "10: x"),
      metadata: { truncated: true },
    };
    expect(parseDelivery(result)).toEqual({
      source: EDeliverySource.Header,
      lineCount: 20,
      range: { start: 10, end: 29 },
      reachedEof: false,
    });
  });

  it("knows the file's size when the read reached its end", () => {
    const whole = {
      output: { type: "file", content: "a\nb\nc\n" },
      content: text("Read file AGENTS.md, lines 1-3"),
      metadata: { truncated: false },
    };
    expect(parseDelivery(whole)).toMatchObject({ range: { start: 1, end: 3 }, reachedEof: true, fileLines: 3 });
    const lastPage = {
      output: { type: "text-page", content: "x", offset: 2400, truncated: false },
      content: text("Read file long.md, lines 2400-2500"),
      metadata: { truncated: false },
    };
    expect(parseDelivery(lastPage)).toMatchObject({ lineCount: 101, reachedEof: true, fileLines: 2500 });
  });

  it("does not claim the end of the file when the tool does not say so", () => {
    const delivered = parseDelivery({ content: text("Read file a.md, lines 1-5") });
    expect(delivered).toMatchObject({ range: { start: 1, end: 5 }, reachedEof: false });
    expect(delivered?.fileLines).toBeUndefined();
  });

  it("delivers nothing for an empty file, and says the file was empty", () => {
    expect(parseDelivery({ output: { type: "file", content: "" }, content: text("Read file .ai/empty.md, 0 lines"), metadata: { truncated: false } })).toEqual({
      source: EDeliverySource.Header,
      lineCount: 0,
      reachedEof: true,
      fileLines: 0,
    });
  });

  it("copes with commas in the path and with string content", () => {
    expect(parseDelivery({ content: "Read file docs/a, b.md, lines 4-6\n4: x" })).toMatchObject({ range: { start: 4, end: 6 } });
  });

  it("falls back to a paged output's offset and line count", () => {
    const result = { output: { type: "text-page", content: "a\nb\nc", offset: 7, truncated: true, next: 10 } };
    expect(parseDelivery(result)).toEqual({
      source: EDeliverySource.Page,
      lineCount: 3,
      range: { start: 7, end: 9 },
      reachedEof: false,
    });
  });

  it("returns undefined when nothing trustworthy is there", () => {
    expect(parseDelivery(undefined)).toBeUndefined();
    expect(parseDelivery({})).toBeUndefined();
    expect(parseDelivery({ content: text("Something else entirely") })).toBeUndefined();
    expect(parseDelivery({ content: text("Read file a.md, lines 9-3") })).toBeUndefined();
    expect(parseDelivery({ content: text("Read file a.md, lines 0-3") })).toBeUndefined();
    expect(parseDelivery({ output: { type: "file", content: "a" } })).toBeUndefined();
    expect(parseDelivery({ content: 42, output: "str", metadata: null })).toBeUndefined();
  });

  it("does not mutate the result and keeps no contents", () => {
    const result = { output: { type: "text-page", content: "SECRET", offset: 1, truncated: false }, content: text("Read file a.md, lines 1-1", "1: SECRET") };
    const snapshot = JSON.stringify(result);
    const delivered = parseDelivery(result);
    expect(JSON.stringify(result)).toBe(snapshot);
    expect(JSON.stringify(delivered)).not.toContain("SECRET");
  });
});
