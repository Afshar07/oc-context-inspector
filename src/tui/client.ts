import type { Plugin } from "@opencode/plugin/tui";
import { ContextInspectorRpc } from "../rpc.js";
import type { ICoverageClient } from "./source.js";

/** The session's user messages: the task the analysis judges relevance against. */
async function userPrompts(ctx: Plugin.Context, sessionID: string): Promise<string[]> {
  await ctx.data.session.message.sync(sessionID).catch(() => {});
  return ctx.data.session.message
    .list(sessionID)
    .flatMap((message) => (message.type === "user" && message.text.trim() !== "" ? [message.text] : []));
}

/** Calls the server half over RPC, routed to the server instance that owns the session's project. */
export function rpcCoverageClient(ctx: Plugin.Context): ICoverageClient {
  const rpc = ctx.client.rpc(ContextInspectorRpc);
  const routed = (sessionID: string) => {
    const directory = ctx.data.session.get(sessionID)?.location.directory;
    return directory ? { location: { directory } } : undefined;
  };
  return {
    coverage: (sessionID) => rpc.coverage({ sessionID }, routed(sessionID)),
    preview: async (sessionID, filePath) => {
      const result = await rpc.preview({ sessionID, filePath }, routed(sessionID));
      return result.found ? result.preview : undefined;
    },
    onRead: (handler) => rpc.events.on("read", (event) => handler(event.data)),
    analyzeSession: async (sessionID) =>
      rpc.analyzeSession({ sessionID, task: await userPrompts(ctx, sessionID) }, routed(sessionID)),
    reviewProject: (sessionID) => rpc.reviewProject({}, routed(sessionID)),
  };
}
