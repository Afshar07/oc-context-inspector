import type { Plugin } from "@opencode/plugin/tui";
import { parseModelRef } from "../model-ref.js";
import { ContextInspectorRpc } from "../rpc.js";
import type { ICoverageClient } from "./source.js";
import { discoverSessions, type ISessionNode } from "./descendants.js";
import { buildTimeline } from "./timeline.js";

/**
 * Opens a follow-up session holding `message` queued (not sent): the agent sees it
 * only with the user's first instruction. A session analysis forks the analyzed
 * session so its history comes along; a project review starts a fresh session.
 * Returns the new session's ID.
 */
export async function startFollowUpSession(
  ctx: Plugin.Context,
  input: {
    readonly fork: boolean;
    readonly sessionID: string;
    readonly title: string;
    readonly message: string;
    /** `provider/model[#variant]` the analysis ran on; the new session switches to it. Ignored when not a model id. */
    readonly model?: string;
  },
): Promise<string> {
  // Session calls are routed by session ID; only a new session needs the project's directory.
  const directory = ctx.data.session.get(input.sessionID)?.location.directory;
  const session = input.fork
    ? await ctx.client.session.fork({ sessionID: input.sessionID })
    : await ctx.client.session.create({ title: input.title, ...(directory && { location: { directory } }) });
  // A fork keeps the original title; the rename is cosmetic, so a failure is not fatal.
  if (input.fork) await ctx.client.session.update({ sessionID: session.id, title: input.title }).catch(() => {});
  // A fork otherwise keeps the analyzed session's model, not the one the user just picked for the analysis.
  // "OpenCode default" (no explicit model) does not parse and leaves the session as it is. Not fatal if it fails.
  const model = parseModelRef(input.model);
  if (model) await ctx.client.session.switchModel({ sessionID: session.id, model }).catch(() => {});
  await ctx.client.session.synthetic({
    sessionID: session.id,
    text: input.message,
    description: "Context review",
    resume: false,
  });
  return session.id;
}

/** "" in the picker: let the server use `analysis.model`, or OpenCode's default. */
export const DEFAULT_MODEL = "";

/**
 * Asks which model should run the analysis, preselecting `current`. Resolves to a
 * `provider/model` ID, DEFAULT_MODEL, or undefined when the user cancels.
 */
export async function pickAnalysisModel(ctx: Plugin.Context, sessionID: string, current: string): Promise<string | undefined> {
  const location = ctx.data.session.get(sessionID)?.location;
  await ctx.data.location.model.sync(location).catch(() => {});
  const models = ctx.data.location.model.list(location) ?? [];
  return ctx.ui.dialog.select({
    title: "Model for context analysis",
    placeholder: "Search models",
    current,
    options: [
      { title: "Default (from config)", value: DEFAULT_MODEL, description: "analysis.model, or OpenCode's default model" },
      ...models.map((m) => ({
        title: m.name,
        value: `${m.providerID}/${m.id}`,
        description: `${m.providerID}/${m.id}`,
        category: m.providerID,
      })),
    ],
  });
}

/** The session's user messages: the task the analysis judges relevance against. */
export async function userPrompts(ctx: Plugin.Context, sessionID: string): Promise<string[]> {
  await ctx.data.session.message.sync(sessionID).catch(() => {});
  return ctx.data.session.message
    .list(sessionID)
    .flatMap((message) => (message.type === "user" && message.text.trim() !== "" ? [message.text] : []));
}

/** Direct children of a session, all pages, through OpenCode's session listing. */
export async function listChildSessions(ctx: Plugin.Context, parentID: string): Promise<ISessionNode[]> {
  const found: ISessionNode[] = [];
  let cursor: string | undefined;
  do {
    const page = await ctx.client.session.list({ parentID, order: "asc", limit: 100, ...(cursor && { cursor }) });
    for (const s of page.data) found.push({ id: s.id, ...(s.parentID && { parentID: s.parentID }), ...(s.agent && { agent: s.agent }) });
    cursor = page.data.length > 0 ? (page.cursor.next ?? undefined) : undefined;
  } while (cursor !== undefined);
  return found;
}

/**
 * The steps of the session and of every session it delegated to, from OpenCode's own message log.
 * Subagents are found through the session listing, not through context reads. Undefined when nothing
 * could be loaded: the review then says ordering is unknown.
 */
async function sessionTimeline(ctx: Plugin.Context, client: ICoverageClient, sessionID: string) {
  const directory = ctx.data.session.get(sessionID)?.location.directory;
  if (!directory) return undefined;
  const report = await client.coverage(sessionID).catch(() => undefined);
  const known = (report?.files ?? []).flatMap((f) => f.agents).filter((a) => a.sessionID !== sessionID);
  const { sessions, roster } = await discoverSessions(
    sessionID,
    {
      listChildren: (parentID) => listChildSessions(ctx, parentID),
      loadMessages: async (id) => {
        await ctx.data.session.message.sync(id);
        return ctx.data.session.message.list(id) as readonly unknown[];
      },
    },
    known,
  );
  const { events, omitted } = buildTimeline(sessions, directory);
  return events.length > 0 || roster.length > 1 ? { events, omitted, sessions: roster } : undefined;
}

/** Calls the server half over RPC, routed to the server instance that owns the session's project. */
export function rpcCoverageClient(ctx: Plugin.Context): ICoverageClient {
  const rpc = ctx.client.rpc(ContextInspectorRpc);
  const routed = (sessionID: string) => {
    const directory = ctx.data.session.get(sessionID)?.location.directory;
    return directory ? { location: { directory } } : undefined;
  };
  const client: ICoverageClient = {
    coverage: (sessionID) => rpc.coverage({ sessionID }, routed(sessionID)),
    preview: async (sessionID, filePath) => {
      const result = await rpc.preview({ sessionID, filePath }, routed(sessionID));
      return result.found ? result.preview : undefined;
    },
    onRead: (handler) => rpc.events.on("read", (event) => handler(event.data)),
    analyzeSession: async (sessionID, model) => {
      const task = await userPrompts(ctx, sessionID);
      const timeline = await sessionTimeline(ctx, client, sessionID).catch(() => undefined);
      return rpc.analyzeSession({ sessionID, task, ...(model && { model }), ...(timeline && { timeline }) }, routed(sessionID));
    },
    reviewProject: (sessionID, model) => rpc.reviewProject({ ...(model && { model }) }, routed(sessionID)),
  };
  return client;
}
