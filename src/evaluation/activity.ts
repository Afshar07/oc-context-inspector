import type { ISessionActivity } from "./types.js";

/** Tools that change files: what "before acting" is measured against. */
export const ACTION_TOOLS: ReadonlySet<string> = new Set(["edit", "write", "patch", "apply_patch", "multiedit"]);
const SHELL_TOOLS: ReadonlySet<string> = new Set(["bash", "shell"]);
/** Command words that suggest a test, type-check, lint or build run. A name match says nothing about the result. */
const VERIFICATION = /\b(test|tests|vitest|jest|mocha|pytest|tsc|typecheck|lint|eslint|build|check|e2e|cargo\s+(?:test|check|build)|go\s+(?:test|vet|build)|mvn|gradle)\b/i;

type Obj = Readonly<Record<string, unknown>>;
const asObj = (v: unknown): Obj | undefined => (typeof v === "object" && v !== null ? (v as Obj) : undefined);
const asString = (v: unknown): string | undefined => (typeof v === "string" && v !== "" ? v : undefined);
const asNumber = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

/** One session's OpenCode messages, read defensively. */
export interface IActivitySession {
  readonly messages: readonly unknown[];
}

/**
 * Counts what a lead session and its subagents did, from OpenCode's own message log. Pure and local:
 * command text is looked at only to tell a test-like run apart and is never returned. Unknown message
 * shapes are skipped, so a platform change shortens the counts rather than failing.
 *
 * `unavailable` is the number of sessions whose messages could not be loaded; with any, `complete` is false.
 */
export function summarizeActivity(sessionID: string, sessions: readonly IActivitySession[], unavailable: number): ISessionActivity {
  let firstAction: number | undefined;
  let actionCount = 0;
  const shell = { runs: 0, withExit: 0, nonZero: 0 };
  const verify = { runs: 0, withExit: 0, nonZero: 0 };

  const countRun = (command: string | undefined, exit: number | undefined) => {
    const buckets = command !== undefined && VERIFICATION.test(command.split(/\r?\n/, 1)[0] ?? "") ? [shell, verify] : [shell];
    for (const bucket of buckets) {
      bucket.runs++;
      if (exit !== undefined) {
        bucket.withExit++;
        if (exit !== 0) bucket.nonZero++;
      }
    }
  };

  for (const session of sessions) {
    for (const raw of session.messages) {
      const message = asObj(raw);
      if (!message) continue;
      const created = asNumber(asObj(message.time)?.created);
      if (message.type === "shell") {
        countRun(asString(message.command), message.status === "exited" ? asNumber(message.exit) : undefined);
        continue;
      }
      if (message.type !== "assistant" || !Array.isArray(message.content)) continue;
      for (const rawPart of message.content) {
        const part = asObj(rawPart);
        const state = asObj(part?.state);
        const name = asString(part?.name);
        if (part?.type !== "tool" || !name || (state?.status !== "completed" && state?.status !== "error")) continue;
        if (ACTION_TOOLS.has(name)) {
          actionCount++;
          const at = asNumber(asObj(part.time)?.created) ?? created;
          if (at !== undefined && (firstAction === undefined || at < firstAction)) firstAction = at;
        } else if (SHELL_TOOLS.has(name)) {
          const metadata = asObj(state.metadata);
          countRun(asString(asObj(state.input)?.command), asNumber(metadata?.exit) ?? asNumber(metadata?.exitCode));
        }
      }
    }
  }
  return {
    sessionID,
    complete: unavailable === 0,
    unavailableSessions: unavailable,
    ...(firstAction !== undefined && { firstActionAt: new Date(firstAction).toISOString() }),
    actionCount,
    shellRuns: shell.runs,
    shellWithExit: shell.withExit,
    shellNonZero: shell.nonZero,
    verificationRuns: verify.runs,
    verificationWithExit: verify.withExit,
    verificationNonZero: verify.nonZero,
  };
}
