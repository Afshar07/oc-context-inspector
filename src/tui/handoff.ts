import type { IFileCoverage } from "../types.js";
import type { EAnalysisMode } from "./Analysis.js";
import { describeFile, STATUS_GLYPH } from "./format.js";

export interface IHandoffInput {
  readonly mode: EAnalysisMode;
  /** The model's review, as shown in the panel. */
  readonly answer: string;
  readonly model: string;
  readonly sessionCount?: number;
  /** The analyzed session's coverage; only used for a session analysis. */
  readonly files: readonly IFileCoverage[];
}

/**
 * First message of the follow-up session. It is queued, not sent: the agent only
 * sees it together with the user's first instruction.
 */
export function handoffMessage(input: IHandoffInput): string {
  const scope =
    input.mode === "session"
      ? "how this session used the project's context files"
      : `how ${input.sessionCount ?? "the"} recorded sessions used the project's context files`;
  const reads =
    input.mode === "session" && input.files.length > 0
      ? `\n\n## Context reads in the analyzed session\n${input.files
          .map((f) => {
            const detail = describeFile(f);
            return `- ${STATUS_GLYPH[f.status]} ${f.filePath}${detail ? ` — ${detail}` : ""}`;
          })
          .join("\n")}\n(● fully read · ◐ partly read · ○ not read · ◌ auto-loaded · ✕ read failed)`
      : "";
  return `# Context review (opencode-context-inspector)

A model (${input.model}) reviewed ${scope}. Its review is below.

Wait for the user's instructions before changing anything. When asked to act on the review, prefer edits to the project's context files (such as AGENTS.md and docs under .ai/) over source code, and read a file before changing it.

## Review
${input.answer}${reads}
`;
}
