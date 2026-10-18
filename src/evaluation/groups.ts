import type { SessionRegistry } from "../sessions.js";
import { ESessionLineage, ESessionTracking } from "../types.js";
import { classifySessionRevision } from "./revisions.js";
import type { EvaluationStore } from "./store.js";
import { ERevisionState, type ISessionRevision } from "./types.js";

/** A lead session, its subagents, and the revision they ran under as one unit. */
export interface IGroupRevision extends ISessionRevision {
  readonly leadSessionID: string;
  readonly members: readonly string[];
  /** Models and plugin configurations seen on model requests by any member. */
  readonly models: readonly string[];
  readonly environments: readonly string[];
  readonly firstSeenAt?: string;
}

/**
 * Resolves lead sessions and their groups. A lead and the sessions it spawned are one sample: they share a
 * task, so counting a subagent as a separate success would count the same work twice.
 */
export class GroupResolver {
  constructor(
    private readonly registry: SessionRegistry,
    private readonly store: EvaluationStore,
  ) {}

  /** The top-most known ancestor of `sessionID`, or the session itself; undefined when the session is not known at all. */
  async leadOf(sessionID: string): Promise<string | undefined> {
    const observation = await this.registry.get(sessionID);
    if (observation.tracking === ESessionTracking.Unobserved) return undefined;
    const chain = await this.registry.ancestors(sessionID);
    return chain[chain.length - 1] ?? sessionID;
  }

  /** Every known session that was not spawned by another, sorted by first observation (unobserved last), then ID. */
  async leads(): Promise<string[]> {
    const sessions = await this.registry.list();
    return sessions
      .filter((s) => s.lineage !== ESessionLineage.Child && s.parentSessionID === undefined)
      .sort((a, b) => (a.firstObservedAt ?? "￿").localeCompare(b.firstObservedAt ?? "￿") || a.sessionID.localeCompare(b.sessionID))
      .map((s) => s.sessionID);
  }

  async descendantCount(lead: string): Promise<number> {
    return (await this.registry.tree(lead)).size - 1;
  }

  /**
   * The group's revision. It is stable only when every member is stable and all saw the same revision;
   * a member with no usable record makes the group unknown, and any difference makes it mixed.
   */
  async revision(lead: string): Promise<IGroupRevision> {
    const members = [...(await this.registry.tree(lead)).keys()].sort((a, b) => (a === lead ? -1 : b === lead ? 1 : a.localeCompare(b)));
    const records = await Promise.all(members.map((id) => this.store.getSessionRecord(id)));
    const classified = members.map((id, i) => classifySessionRevision(id, records[i]));
    const models = [...new Set(records.flatMap((r) => r?.models ?? []))].sort();
    const environments = [...new Set(records.flatMap((r) => (r?.environment !== undefined ? [r.environment] : [])))].sort();
    const firstSeenAt = records[0]?.firstSeenAt;
    const base = { leadSessionID: lead, members, models, environments, ...(firstSeenAt !== undefined && { firstSeenAt }) };

    const unknown = classified.find((c) => c.state === ERevisionState.Unknown);
    if (unknown) {
      const who = unknown.sessionID === lead ? "" : `subagent ${unknown.sessionID}: `;
      return { ...base, sessionID: lead, state: ERevisionState.Unknown, reason: `${who}${unknown.reason ?? "unknown"}`, revisionIds: [] };
    }
    const revisionIds = [...new Set(classified.flatMap((c) => c.revisionIds))];
    const mixed = classified.find((c) => c.state === ERevisionState.Mixed);
    if (mixed || revisionIds.length > 1) {
      return {
        ...base,
        sessionID: lead,
        state: ERevisionState.Mixed,
        reason: mixed ? `${mixed.sessionID === lead ? "" : `subagent ${mixed.sessionID}: `}${mixed.reason}` : "the lead and its subagents ran under different revisions",
        ...(classified[0]?.startRevisionId !== undefined && { startRevisionId: classified[0].startRevisionId }),
        revisionIds,
      };
    }
    return { ...base, sessionID: lead, state: ERevisionState.Stable, ...(classified[0]?.startRevisionId !== undefined && { startRevisionId: classified[0].startRevisionId }), revisionIds };
  }
}
