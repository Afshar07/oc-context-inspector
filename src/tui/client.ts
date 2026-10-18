import type { Plugin } from "@opencode/plugin/tui";
import { ContextInspectorRpc } from "../rpc.js";
import type { ICoverageClient } from "./source.js";

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
  };
}
