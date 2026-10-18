import { ETimelineKind, type ITimelineEvent } from "../types.js";

/** Cap on events sent per analysis; the oldest ordinary tool steps are dropped first. */
export const MAX_TIMELINE_EVENTS = 300;
const MAX_USER_CHARS = 300;
const MAX_ERROR_CHARS = 200;
const MAX_COMMAND_CHARS = 120;

/** One session's messages. `messages` is OpenCode's `SessionMessageInfo[]`, read defensively. */
export interface ITimelineSession {
  readonly sessionID: string;
  readonly messages: readonly unknown[];
}

export interface ITimeline {
  readonly events: readonly ITimelineEvent[];
  /** Events dropped by the cap, oldest first. */
  readonly omitted: number;
}

type Obj = Readonly<Record<string, unknown>>;

const asObj = (v: unknown): Obj | undefined => (typeof v === "object" && v !== null ? (v as Obj) : undefined);
const asString = (v: unknown): string | undefined => (typeof v === "string" && v !== "" ? v : undefined);
const asNumber = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);
const firstLine = (text: string) => text.split(/\r?\n/, 1)[0] ?? "";

/** Project-relative POSIX path, or undefined for a path outside the project. */
export function toProjectPath(raw: string, directory: string): string | undefined {
  const posix = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "");
  const target = posix(raw);
  const root = posix(directory);
  const absolute = target.startsWith("/") || /^[a-z]:\//i.test(target);
  if (!absolute) {
    const rel = target.replace(/^\.\//, "");
    return rel.split("/").includes("..") ? undefined : rel;
  }
  const same = /^[a-z]:\//i.test(root) ? target.toLowerCase().startsWith(`${root.toLowerCase()}/`) : target.startsWith(`${root}/`);
  return same ? target.slice(root.length + 1) : undefined;
}

/** Copies primitives out of a tool input; never the whole input, which can carry file contents. */
function inputPath(input: unknown, directory: string): string | undefined {
  const args = asObj(input);
  const raw = asString(args?.path) ?? asString(args?.filePath);
  return raw === undefined ? undefined : toProjectPath(raw, directory);
}

const iso = (ms: number | undefined) => new Date(ms ?? 0).toISOString();

function messageEvents(sessionID: string, message: Obj, directory: string): ITimelineEvent[] {
  const created = asNumber(asObj(message.time)?.created);
  switch (message.type) {
    case "user": {
      const text = asString(message.text)?.trim();
      return text ? [{ at: iso(created), sessionID, kind: ETimelineKind.User, text: clip(text, MAX_USER_CHARS) }] : [];
    }
    case "shell": {
      const command = asString(message.command);
      const exit = asNumber(message.exit);
      return [
        {
          at: iso(created),
          sessionID,
          kind: ETimelineKind.Shell,
          ...(command !== undefined && { command: clip(firstLine(command), MAX_COMMAND_CHARS) }),
          ...(exit !== undefined && { exit }),
          ...(message.status === "exited" ? {} : { text: String(message.status ?? "") }),
        },
      ];
    }
    case "agent-switched": {
      const agent = asString(message.agent);
      return agent ? [{ at: iso(created), sessionID, kind: ETimelineKind.AgentSwitch, agentID: agent }] : [];
    }
    case "compaction":
      return [{ at: iso(created), sessionID, kind: ETimelineKind.Compaction }];
    case "assistant": {
      const agentID = asString(message.agent);
      const parts = Array.isArray(message.content) ? message.content : [];
      return parts.flatMap((raw): ITimelineEvent[] => {
        const part = asObj(raw);
        const state = asObj(part?.state);
        const name = asString(part?.name);
        if (part?.type !== "tool" || !name) return [];
        const status = state?.status;
        if (status !== "completed" && status !== "error") return [];
        const path = inputPath(state?.input, directory);
        const callID = asString(part.id);
        const error = status === "error" ? asString(asObj(state?.error)?.message) : undefined;
        return [
          {
            at: iso(asNumber(asObj(part.time)?.created) ?? created),
            sessionID,
            ...(agentID !== undefined && { agentID }),
            kind: ETimelineKind.Tool,
            tool: name,
            status,
            ...(path !== undefined && { path }),
            ...(callID !== undefined && { callID }),
            ...(error !== undefined && { text: clip(error, MAX_ERROR_CHARS) }),
          },
        ];
      });
    }
    default:
      return [];
  }
}

/** Events worth keeping when the cap bites: what the reviewer judges against. */
const isEssential = (e: ITimelineEvent) =>
  e.kind !== ETimelineKind.Tool || e.status === "error" || e.path !== undefined || e.tool === "read" || e.tool === "edit" || e.tool === "write";

/**
 * Orders the steps of a session and the sessions it spawned. Pure: unknown message shapes
 * are skipped, so a platform change degrades to a shorter timeline, never an error.
 */
export function buildTimeline(sessions: readonly ITimelineSession[], directory: string): ITimeline {
  const all = sessions
    .flatMap((s) =>
      s.messages.flatMap((raw, order) => {
        const message = asObj(raw);
        return message ? messageEvents(s.sessionID, message, directory).map((event, i) => ({ event, order: order * 1000 + i })) : [];
      }),
    )
    .sort((a, b) => a.event.at.localeCompare(b.event.at) || a.event.sessionID.localeCompare(b.event.sessionID) || a.order - b.order)
    .map((x) => x.event);
  if (all.length <= MAX_TIMELINE_EVENTS) return { events: all, omitted: 0 };

  // Drop the oldest unimportant tool steps first, then the oldest of what remains.
  const drop = new Set<number>();
  const need = all.length - MAX_TIMELINE_EVENTS;
  for (const essential of [false, true]) {
    for (let i = 0; i < all.length && drop.size < need; i++) {
      const e = all[i]!;
      if (e.kind === ETimelineKind.User) continue;
      if (isEssential(e) === essential) drop.add(i);
    }
  }
  return { events: all.filter((_, i) => !drop.has(i)), omitted: drop.size };
}
