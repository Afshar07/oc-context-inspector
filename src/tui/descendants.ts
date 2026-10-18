import { ETimelineSessionState, type ITimelineSessionInfo } from "../types.js";
import type { ITimelineSession } from "./timeline.js";

/** Safety bounds on a delegation tree; hitting one is reported, never silent. */
export const MAX_DESCENDANT_SESSIONS = 50;
export const MAX_DESCENDANT_DEPTH = 6;

/** The few fields of OpenCode's `SessionInfo` that discovery needs. */
export interface ISessionNode {
  readonly id: string;
  readonly parentID?: string;
  readonly agent?: string;
}

/** A session already known from another source (the coverage report), used when listing falls short. */
export interface IKnownSession {
  readonly sessionID: string;
  readonly agentID?: string;
  readonly parentSessionID?: string;
}

export interface IDescendantDeps {
  /** Every direct child of `parentID`, all pages. Rejects when the listing fails. */
  readonly listChildren: (parentID: string) => Promise<readonly ISessionNode[]>;
  /** The session's messages. Rejects when they cannot be synced. */
  readonly loadMessages: (sessionID: string) => Promise<readonly unknown[]>;
}

export interface IDescendantResult {
  /** Messages per loaded session, the analyzed session first. */
  readonly sessions: readonly ITimelineSession[];
  /** One entry per session, loaded or not, in discovery order. */
  readonly roster: readonly ITimelineSessionInfo[];
}

interface INode {
  readonly info: Omit<ITimelineSessionInfo, "state" | "messages" | "reason">;
  note?: string;
}

/**
 * Walks the sessions spawned from `rootID` breadth-first through OpenCode's own session listing
 * (`parentID` filter), so a subagent is found even if it never read a context file. `known`
 * sessions the listing missed are added as descendants. Each session appears once; a failure to
 * list children or load messages stays in the roster instead of dropping the session.
 */
export async function discoverSessions(
  rootID: string,
  deps: IDescendantDeps,
  known: readonly IKnownSession[] = [],
): Promise<IDescendantResult> {
  const nodes = new Map<string, INode>([[rootID, { info: { sessionID: rootID, depth: 0 } }]]);
  let truncated = false;

  const admit = (node: ISessionNode, parentID: string, depth: number): boolean => {
    if (nodes.has(node.id)) return false;
    if (nodes.size >= MAX_DESCENDANT_SESSIONS) {
      truncated = true;
      return false;
    }
    nodes.set(node.id, {
      info: { sessionID: node.id, parentID: node.parentID ?? parentID, depth, ...(node.agent !== undefined && { agentID: node.agent }) },
    });
    return true;
  };

  let level = [rootID];
  for (let depth = 1; level.length > 0; depth++) {
    if (depth > MAX_DESCENDANT_DEPTH) {
      truncated = true;
      break;
    }
    const listed = await Promise.all(
      level.map(async (parentID) => ({ parentID, children: await deps.listChildren(parentID).catch(() => undefined) })),
    );
    const next: string[] = [];
    for (const { parentID, children } of listed) {
      if (children === undefined) {
        nodes.get(parentID)!.note = "child sessions could not be listed";
        continue;
      }
      for (const child of children) if (admit(child, parentID, depth)) next.push(child.id);
    }
    level = next;
  }

  // The listing is authoritative, but a session the coverage report names must not vanish if it was missed.
  for (const k of known) {
    if (nodes.has(k.sessionID)) continue;
    const parent = k.parentSessionID !== undefined && nodes.has(k.parentSessionID) ? k.parentSessionID : rootID;
    const depth = (nodes.get(parent)?.info.depth ?? 0) + 1;
    admit({ id: k.sessionID, ...(k.agentID !== undefined && { agent: k.agentID }) }, parent, depth);
  }

  const loaded = await Promise.all(
    [...nodes.values()].map(async ({ info, note }) => {
      const messages = await deps.loadMessages(info.sessionID).catch(() => undefined);
      const reason = [messages === undefined ? "message sync failed" : undefined, note].filter(Boolean).join("; ");
      const entry: ITimelineSessionInfo = {
        ...info,
        state: messages === undefined ? ETimelineSessionState.Unavailable : ETimelineSessionState.Loaded,
        messages: messages?.length ?? 0,
        ...(reason !== "" && { reason }),
      };
      return { entry, messages };
    }),
  );
  const roster = loaded.map(({ entry }) => entry);
  if (truncated) {
    const root = roster[0]!;
    roster[0] = { ...root, reason: [root.reason, "delegation tree truncated at the session limit"].filter(Boolean).join("; ") };
  }
  return {
    sessions: loaded.flatMap(({ entry, messages }) => (messages === undefined ? [] : [{ sessionID: entry.sessionID, messages }])),
    roster,
  };
}
