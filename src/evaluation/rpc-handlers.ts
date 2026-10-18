import type { RevisionSnapshotter } from "./revisions.js";
import type { EvaluationService } from "./evaluate.js";
import { ExperimentError, type ExperimentService } from "./experiments.js";
import type { GroupResolver } from "./groups.js";
import type { EAdherence, EExperimentRole, ETaskOutcome, IExperimentOrigin, ISessionActivity } from "./types.js";

export interface IEvaluationServices {
  readonly experiments: ExperimentService;
  readonly evaluation: EvaluationService;
  readonly groups: GroupResolver;
  readonly snapshotter: RevisionSnapshotter;
}

/** A user-correctable problem is shown as written; anything else is a fault and gets a generic prefix. */
const failure = (error: unknown) => ({
  ok: false as const,
  error: error instanceof ExperimentError ? error.message : `Context experiment failed: ${error instanceof Error ? error.message : String(error)}`,
});

async function attempt<T extends object>(run: () => Promise<T>) {
  try {
    return { ok: true as const, ...(await run()) };
  } catch (error) {
    return failure(error);
  }
}

/**
 * Handlers of the evaluation RPC methods. Every mutation is explicit user input; nothing here edits a
 * documentation file, runs an agent or calls a model.
 */
export function evaluationHandlers({ experiments, evaluation, groups, snapshotter }: IEvaluationServices) {
  return {
    sessionRevision: ({ sessionID }: { sessionID: string }) =>
      groups.leadOf(sessionID).then((lead) => groups.revision(lead ?? sessionID)),
    currentRevision: async (_: object) => {
      const snapshot = await snapshotter.current();
      return { revisionId: snapshot.id, fileCount: snapshot.files.length, createdAt: snapshot.createdAt };
    },
    listExperiments: async (_: object) => {
      const { experiments: list, unreadable } = await experiments.list();
      return { experiments: list, unreadable: unreadable.length };
    },
    createExperiment: (input: {
      name: string;
      hypothesis: string;
      targetFiles: readonly string[];
      taskCategory?: string;
      description?: string;
      baselineSessionIDs?: readonly string[];
      origin?: IExperimentOrigin;
    }) => attempt(async () => ({ experiment: await experiments.create(input) })),
    closeExperiment: ({ id, reason }: { id: string; reason?: string }) =>
      attempt(async () => ({ experiment: await experiments.close(id, reason) })),
    detectCandidate: ({ id }: { id: string }) => attempt(async () => ({ detection: await experiments.detectCandidate(id) })),
    confirmCandidate: ({ id, revisionId }: { id: string; revisionId: string }) =>
      attempt(async () => ({ experiment: await experiments.confirmCandidate(id, revisionId) })),
    experimentSessions: ({ id }: { id: string }) => attempt(async () => ({ offers: await experiments.offers(id) })),
    setExperimentSessions: ({ id, add, remove }: { id: string; add?: readonly { sessionID: string; role: EExperimentRole }[]; remove?: readonly string[] }) =>
      attempt(async () => ({
        experiment: await experiments.setSessions(id, { ...(add && { add }), ...(remove && { remove }) }),
      })),
    labelSession: ({ id, sessionID, ...label }: { id: string; sessionID: string; taskSuccess?: ETaskOutcome; adherence?: EAdherence; note?: string; evidenceRef?: string; clear?: boolean }) =>
      attempt(async () => ({ experiment: await experiments.label(id, sessionID, label) })),
    evaluateExperiment: ({ id, activity }: { id: string; activity?: readonly ISessionActivity[] }) =>
      attempt(async () => ({ result: await evaluation.evaluate(id, activity ?? []) })),
  };
}
