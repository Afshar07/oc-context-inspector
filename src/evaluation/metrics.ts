import { mergeRanges, summarizeAgents } from "../coverage.js";
import { EReadStatus, type IContextReadRecord, type ILineRange } from "../types.js";
import {
  ECompleteness,
  EMissing,
  type EExperimentRole,
  type ERevisionState,
  type IGroupMeasurement,
  type IOutcomeLabel,
  type ISessionActivity,
} from "./types.js";

export interface IGroupInput {
  /** The lead session. */
  readonly sessionID: string;
  readonly role: EExperimentRole;
  /** The lead and its descendants. */
  readonly members: readonly string[];
  /** Read records of every member, for any context file. */
  readonly records: readonly IContextReadRecord[];
  readonly targets: ReadonlySet<string>;
  /** Project-relative files OpenCode injects itself. */
  readonly autoLoaded: readonly string[];
  readonly revisionState: ERevisionState;
  readonly activity?: ISessionActivity;
  readonly models: readonly string[];
  readonly environments: readonly string[];
  readonly outcome?: IOutcomeLabel;
}

const sumLines = (ranges: readonly ILineRange[]) => ranges.reduce((n, r) => n + r.end - r.start + 1, 0);
const versionKey = (r: IContextReadRecord) => (r.fileAtRead ? `${r.fileAtRead.mtimeMs}:${r.fileAtRead.sizeBytes}` : "unversioned");
const byCompletion = (a: IContextReadRecord, b: IContextReadRecord) => a.completedAt.localeCompare(b.completedAt);

/**
 * Whether the reads of one file covered it, judged against the file as it was read (never as it is now:
 * baseline and candidate sessions saw different versions). Unknown when the tool left no delivery information.
 */
export function fileCompleteness(reads: readonly IContextReadRecord[]): ECompleteness {
  const completed = reads.filter((r) => r.status === EReadStatus.Completed).sort(byCompletion);
  const latest = completed[completed.length - 1];
  if (!latest) return ECompleteness.Unknown;
  const version = completed.filter((r) => versionKey(r) === versionKey(latest));
  if (version.some((r) => r.delivered === undefined)) return ECompleteness.Unknown;
  const total = version.map((r) => r.delivered?.fileLines).find((n): n is number => n !== undefined);
  const ranges = mergeRanges(version.flatMap((r) => r.delivered?.range ?? []));
  if (total === undefined) return version.some((r) => r.delivered && !r.delivered.reachedEof) ? ECompleteness.Partial : ECompleteness.Unknown;
  return sumLines(ranges) >= total ? ECompleteness.Full : ECompleteness.Partial;
}

function combineCompleteness(perFile: readonly ECompleteness[]): ECompleteness | undefined {
  if (perFile.length === 0) return undefined;
  if (perFile.includes(ECompleteness.Partial)) return ECompleteness.Partial;
  return perFile.includes(ECompleteness.Unknown) ? ECompleteness.Unknown : ECompleteness.Full;
}

/**
 * Deterministic measurements for one lead session and its subagents, from read records and the
 * optional activity summary. Missing evidence is reported as missing, never as a zero or a guess.
 */
export function measureGroup(input: IGroupInput): IGroupMeasurement {
  const targetRecords = input.records.filter((r) => input.targets.has(r.filePath));
  const completed = targetRecords.filter((r) => r.status === EReadStatus.Completed);
  const filesRead = [...new Set(completed.map((r) => r.filePath))].sort();
  const autoLoadedTargets = [...input.targets].filter((t) => input.autoLoaded.includes(t)).sort();
  const onlyAutoLoaded = input.targets.size > 0 && autoLoadedTargets.length === input.targets.size;

  const explicit = completed.length > 0;
  const missingRead = onlyAutoLoaded ? EMissing.AutoLoadedOnly : EMissing.NoRead;

  let readBeforeAction: boolean | undefined;
  let readBeforeActionMissing: EMissing | undefined;
  if (!explicit) readBeforeActionMissing = missingRead;
  else if (!input.activity?.complete) readBeforeActionMissing = EMissing.NoTimeline;
  else if (input.activity.firstActionAt === undefined) readBeforeActionMissing = EMissing.NoAction;
  else {
    const firstRead = Math.min(...completed.map((r) => Date.parse(r.startedAt)));
    readBeforeAction = firstRead < Date.parse(input.activity.firstActionAt);
  }

  const completeness = combineCompleteness(
    filesRead.map((file) => fileCompleteness(completed.filter((r) => r.filePath === file))),
  );

  let repeatReads = 0;
  let crossAgentRereads = 0;
  for (const file of new Set(targetRecords.map((r) => r.filePath))) {
    // Lines are not estimated: a read without delivery information counts as overlapping any earlier read.
    for (const agent of summarizeAgents(targetRecords.filter((r) => r.filePath === file), undefined)) {
      repeatReads += agent.repeatReads;
      crossAgentRereads += agent.handoffRereads;
    }
  }

  let deliveredLines = 0;
  let requestedLines = 0;
  for (const r of completed) {
    if (r.delivered && r.requestedRange.limit !== undefined) {
      deliveredLines += r.delivered.lineCount;
      requestedLines += r.requestedRange.limit;
    }
  }

  return {
    sessionID: input.sessionID,
    role: input.role,
    memberSessionIDs: [...input.members],
    revisionState: input.revisionState,
    explicitTargetRead: explicit,
    targetFilesRead: filesRead,
    autoLoadedTargets,
    ...(readBeforeAction !== undefined && { readBeforeAction }),
    ...(readBeforeActionMissing !== undefined && { readBeforeActionMissing }),
    ...(completeness !== undefined && { completeness }),
    ...(completeness === undefined && { completenessMissing: missingRead }),
    ...(completeness === ECompleteness.Unknown && { completenessMissing: EMissing.NoDelivery }),
    repeatReads,
    crossAgentRereads,
    failedReads: targetRecords.length - completed.length,
    deliveredLines,
    requestedLines,
    contextReads: input.records.length,
    ...(input.activity && { activity: input.activity }),
    models: [...input.models],
    environments: [...input.environments],
    ...(input.outcome && { outcome: input.outcome }),
  };
}
