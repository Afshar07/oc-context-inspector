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
  /** The follow-up is a fork of the analyzed session, so it already holds the conversation. */
  readonly forked?: boolean;
  /** The analyzed session's user messages; the brief for a fresh session that has no history. */
  readonly task?: readonly string[];
}

/** Cap on the task text carried into a fresh session. */
export const MAX_BRIEF_TASK_CHARS = 3_000;

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
          .join("\n")}\n(● fully read · ◐ partly read · ○ not read · ◌ auto-loaded · ✕ read failed · ? coverage unknown · ~ estimated)`
      : "";
  const task = input.mode === "session" && !input.forked ? briefTask(input.task) : "";
  const fresh =
    input.mode === "session" && !input.forked
      ? "This is a new session: it has none of the analyzed session's history. The task and read data below are the brief.\n\n"
      : "";
  return `# Context review (opencode-context-inspector)

A model (${input.model}) reviewed ${scope}. Its review is below.

Wait for the user's instructions before changing anything. When asked to act on the review, prefer edits to the project's context files (such as AGENTS.md and docs under .ai/) over source code, and read a file before changing it.

${fresh}${task}## Review
${input.answer}${reads}
`;
}

function briefTask(task: readonly string[] | undefined): string {
  const text = (task ?? []).join("\n---\n").trim();
  if (text === "") return "";
  const body = text.length > MAX_BRIEF_TASK_CHARS ? `${text.slice(0, MAX_BRIEF_TASK_CHARS)}\n…(truncated)` : text;
  return `## Task of the analyzed session (its user messages)\n${body}\n\n`;
}
