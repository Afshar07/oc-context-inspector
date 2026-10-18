import { describe, expect, it } from "vitest";
import { summarize } from "../src/coverage.js";
import { ContextInspectorRpc } from "../src/rpc.js";

type Standard = { "~standard": { validate: (v: unknown) => unknown } };
const validate = async (schema: unknown, value: unknown) =>
  (await (schema as Standard)["~standard"].validate(value)) as { issues?: unknown[] };

describe("ContextInspectorRpc", () => {
  const coverage = summarize("a.md", [], { exists: true, lineCount: 2 }, false);

  it("accepts what the coverage service produces", async () => {
    const { methods, events } = ContextInspectorRpc;
    expect((await validate(methods.coverage.output, { sessionID: "s", tracking: "observed", files: [coverage] })).issues).toBeUndefined();
    expect(
      (await validate(methods.preview.output, { found: true, preview: { coverage, lines: ["x"], truncated: false, contentMayDiffer: false } }))
        .issues,
    ).toBeUndefined();
    expect((await validate(methods.preview.output, { found: false })).issues).toBeUndefined();
    expect((await validate(events.read.schema, { sessionID: "s", filePath: "a.md" })).issues).toBeUndefined();
    expect((await validate(events.read.schema, { sessionID: "s", filePath: "a.md", ancestors: ["p"] })).issues).toBeUndefined();
  });

  it("rejects malformed input", async () => {
    expect((await validate(ContextInspectorRpc.methods.coverage.input, {})).issues).toBeDefined();
  });
});
