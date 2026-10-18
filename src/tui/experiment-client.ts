import type { Plugin } from "@opencode/plugin/tui";
import { summarizeActivity } from "../evaluation/activity.js";
import type { ICandidateDetection } from "../evaluation/experiments.js";
import type { IGroupRevision } from "../evaluation/groups.js";
import type {
  EAdherence,
  EExperimentRole,
  ETaskOutcome,
  IEvaluationResult,
  IExperiment,
  IExperimentOrigin,
  ISessionActivity,
  ISessionOffer,
} from "../evaluation/types.js";
import { ContextInspectorRpc } from "../rpc.js";
import { ETimelineSessionState } from "../types.js";
import { listChildSessions } from "./client.js";
import { discoverSessions } from "./descendants.js";

export type Reply<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: string };

export interface INewExperiment {
  readonly name: string;
  readonly hypothesis: string;
  readonly targetFiles: readonly string[];
  readonly taskCategory?: string;
  readonly description?: string;
  readonly baselineSessionIDs?: readonly string[];
  readonly origin?: IExperimentOrigin;
}

export interface ILabelRequest {
  readonly taskSuccess?: ETaskOutcome;
  readonly adherence?: EAdherence;
  readonly note?: string;
  readonly evidenceRef?: string;
  readonly clear?: boolean;
}

/**
 * What the TUI needs for experiments. `sessionID` (the session on screen) only routes the call to the
 * server that owns the project. The RPC adapter below is the only implementation.
 */
export interface IExperimentClient {
  list(sessionID: string): Promise<{ readonly experiments: readonly IExperiment[]; readonly unreadable: number }>;
  create(sessionID: string, input: INewExperiment): Promise<Reply<IExperiment>>;
  close(sessionID: string, id: string, reason?: string): Promise<Reply<IExperiment>>;
  detectCandidate(sessionID: string, id: string): Promise<Reply<ICandidateDetection>>;
  confirmCandidate(sessionID: string, id: string, revisionId: string): Promise<Reply<IExperiment>>;
  offers(sessionID: string, id: string): Promise<Reply<readonly ISessionOffer[]>>;
  setSessions(
    sessionID: string,
    id: string,
    change: { readonly add?: readonly { readonly sessionID: string; readonly role: EExperimentRole }[]; readonly remove?: readonly string[] },
  ): Promise<Reply<IExperiment>>;
  label(sessionID: string, id: string, target: string, label: ILabelRequest): Promise<Reply<IExperiment>>;
  /** Gathers per-session activity from OpenCode's message log, then asks the server to compare. */
  evaluate(sessionID: string, id: string): Promise<Reply<IEvaluationResult>>;
  revision(sessionID: string, forSession: string): Promise<IGroupRevision>;
}

/** Counts for one lead session and its subagents; undefined when none of their messages could be loaded. */
async function activityOf(ctx: Plugin.Context, lead: string, members: readonly string[]): Promise<ISessionActivity | undefined> {
  const { sessions, roster } = await discoverSessions(
    lead,
    {
      listChildren: (parentID) => listChildSessions(ctx, parentID),
      loadMessages: async (id) => {
        await ctx.data.session.message.sync(id);
        return ctx.data.session.message.list(id) as readonly unknown[];
      },
    },
    members.filter((m) => m !== lead).map((sessionID) => ({ sessionID, parentSessionID: lead })),
  );
  if (sessions.length === 0) return undefined;
  return summarizeActivity(lead, sessions, roster.filter((r) => r.state === ETimelineSessionState.Unavailable).length);
}

const fromReply = <R extends { ok: boolean }, T>(reply: R, pick: (ok: Extract<R, { ok: true }>) => T): Reply<T> =>
  reply.ok ? { ok: true, value: pick(reply as Extract<R, { ok: true }>) } : { ok: false, error: (reply as unknown as { error: string }).error };

export function rpcExperimentClient(ctx: Plugin.Context): IExperimentClient {
  const rpc = ctx.client.rpc(ContextInspectorRpc);
  const routed = (sessionID: string) => {
    const directory = ctx.data.session.get(sessionID)?.location.directory;
    return directory ? { location: { directory } } : undefined;
  };
  return {
    list: (sessionID) => rpc.listExperiments({}, routed(sessionID)),
    create: async (sessionID, input) => fromReply(await rpc.createExperiment(input, routed(sessionID)), (r) => r.experiment),
    close: async (sessionID, id, reason) =>
      fromReply(await rpc.closeExperiment({ id, ...(reason !== undefined && { reason }) }, routed(sessionID)), (r) => r.experiment),
    detectCandidate: async (sessionID, id) => fromReply(await rpc.detectCandidate({ id }, routed(sessionID)), (r) => r.detection),
    confirmCandidate: async (sessionID, id, revisionId) =>
      fromReply(await rpc.confirmCandidate({ id, revisionId }, routed(sessionID)), (r) => r.experiment),
    offers: async (sessionID, id) => fromReply(await rpc.experimentSessions({ id }, routed(sessionID)), (r) => r.offers),
    setSessions: async (sessionID, id, change) =>
      fromReply(await rpc.setExperimentSessions({ id, ...change }, routed(sessionID)), (r) => r.experiment),
    label: async (sessionID, id, target, label) =>
      fromReply(await rpc.labelSession({ id, sessionID: target, ...label }, routed(sessionID)), (r) => r.experiment),
    revision: (sessionID, forSession) => rpc.sessionRevision({ sessionID: forSession }, routed(sessionID)),
    evaluate: async (sessionID, id) => {
      const { experiments } = await rpc.listExperiments({}, routed(sessionID));
      const experiment = experiments.find((e) => e.id === id);
      const activity: ISessionActivity[] = [];
      // Message logs are loaded a few leads at a time; a lead that fails simply has no activity (missing evidence).
      const leads = experiment?.sessions ?? [];
      for (let i = 0; i < leads.length; i += 4) {
        const batch = await Promise.all(
          leads.slice(i, i + 4).map(async (s) => {
            const revision = await rpc.sessionRevision({ sessionID: s.sessionID }, routed(sessionID)).catch(() => undefined);
            return activityOf(ctx, s.sessionID, revision?.members ?? [s.sessionID]).catch(() => undefined);
          }),
        );
        activity.push(...batch.flatMap((a) => a ?? []));
      }
      return fromReply(await rpc.evaluateExperiment({ id, activity }, routed(sessionID)), (r) => r.result);
    },
  };
}
