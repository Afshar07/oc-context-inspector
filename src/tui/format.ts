import {
  EAgentRole,
  ECoverageCertainty,
  ECoverageStatus,
  ESessionTracking,
  type IAgentReadSummary,
  type ICoverageReport,
  type IFileCoverage,
  type IFilePreview,
  type ILineRange,
} from "../types.js";

export const STATUS_GLYPH: Readonly<Record<ECoverageStatus, string>> = {
  [ECoverageStatus.Full]: "●",
  [ECoverageStatus.Partial]: "◐",
  [ECoverageStatus.Unread]: "○",
  [ECoverageStatus.AutoLoaded]: "◌",
  [ECoverageStatus.Error]: "✕",
  [ECoverageStatus.Unknown]: "?",
};

const coveredLines = (ranges: readonly ILineRange[]) => ranges.reduce((n, r) => n + r.end - r.start + 1, 0);
const formatRange = (r: ILineRange) => `L${r.start}–${r.end}`;

/** The line count the ranges are measured against: the file as read when it has since changed or vanished. */
function measuredAgainst(file: IFileCoverage): number | undefined {
  return file.certainty === ECoverageCertainty.Stale ? file.lineCountAtRead : file.lineCount;
}

/** Reads made by agents in sessions this session spawned. */
const subagentReads = (file: IFileCoverage) => file.agents.filter((a) => a.depth > 0).reduce((n, a) => n + a.readCount, 0);

/** Short right-hand detail for one sidebar row; empty when the glyph says it all. `~` marks ranges that are only estimated. */
export function describeFile(file: IFileCoverage): string {
  const parts: string[] = [];
  const estimated = file.certainty === ECoverageCertainty.Estimated;
  switch (file.status) {
    case ECoverageStatus.Error:
      parts.push(file.exists ? "read failed" : "missing");
      break;
    case ECoverageStatus.AutoLoaded:
      parts.push("auto-loaded");
      break;
    case ECoverageStatus.Unknown:
      parts.push(file.exists ? "coverage unknown" : "deleted · coverage unknown");
      break;
    case ECoverageStatus.Partial: {
      const [only] = file.ranges;
      const total = measuredAgainst(file);
      const of = total === undefined ? "" : `/${total}`;
      parts.push(
        `${estimated ? "~" : ""}${
          file.ranges.length === 1 && only ? `${formatRange(only)}${of}` : `${coveredLines(file.ranges)}${of} lines`
        }`,
      );
      break;
    }
    case ECoverageStatus.Full:
      if (estimated) parts.push("~full");
      break;
    case ECoverageStatus.Unread:
      break;
  }
  if (file.readCount > 1) parts.push(`${file.readCount}×`);
  const delegated = subagentReads(file);
  if (delegated > 0) parts.push(`+${delegated} sub`);
  if (file.readCount > 0 && !file.exists) {
    if (file.status !== ECoverageStatus.Unknown) parts.push("deleted");
  } else if (file.modifiedSinceRead) parts.push("changed");
  return parts.join(" · ");
}

/** "2/5 read": files with at least one successful read, out of files that exist. */
export function summaryLine(report: ICoverageReport): string {
  const existing = report.files.filter((f) => f.exists);
  return `${existing.filter((f) => f.readCount > 0).length}/${existing.length} read`;
}

/** Faint line under the summary when the inspector cannot vouch that an empty list means "nothing read". */
export function trackingNote(report: ICoverageReport): string | undefined {
  if (report.tracking === ESessionTracking.Unobserved) return "session not observed yet";
  if (report.tracking === ESessionTracking.ReadsOnly) return "recorded before session tracking";
  return undefined;
}

export function isLineRead(line: number, ranges: readonly ILineRange[]): boolean {
  return ranges.some((r) => line >= r.start && line <= r.end);
}

/** Sidebar rows: unread files are hidden unless asked for; auto-loaded ones stay, the model saw them. */
export function visibleFiles(files: readonly IFileCoverage[], showUnread: boolean): readonly IFileCoverage[] {
  return showUnread ? files : files.filter((f) => f.status !== ECoverageStatus.Unread);
}

const ROLE_LABEL: Readonly<Record<EAgentRole, string>> = {
  [EAgentRole.Lead]: "lead",
  [EAgentRole.Subagent]: "subagent",
  [EAgentRole.Unknown]: "agent unknown",
};

function describeAgent(a: IAgentReadSummary): string {
  const name = a.agentID ?? "unknown agent";
  const role = a.depth > 1 ? `${ROLE_LABEL[a.role]}, depth ${a.depth}` : ROLE_LABEL[a.role];
  const parts = [
    `${a.readCount}×`,
    ...(a.ranges.length > 0 ? [a.ranges.map(formatRange).join(", ")] : []),
    ...(a.repeatReads > 0 ? [`${a.repeatReads} repeated by itself`] : []),
    ...(a.handoffRereads > 0 ? [`${a.handoffRereads} repeated after handoff`] : []),
    ...(a.errorCount > 0 ? [`${a.errorCount} failed`] : []),
  ];
  return `${name} (${role}) · ${parts.join(" · ")}`;
}

/** One line per agent that read the file, nearest to the viewed session first. */
export function agentLines(file: IFileCoverage): string[] {
  return file.agents.map(describeAgent);
}

/** Why the preview's text and highlights may not match what the agent received; undefined when they do. */
export function previewNotice(preview: IFilePreview): string | undefined {
  if (!preview.contentMayDiffer) return undefined;
  const { coverage } = preview;
  if (!coverage.exists) return "File deleted since it was read: there is no text to show. Ranges are as recorded when the agent read it.";
  if (coverage.modifiedSinceRead) return "File changed since it was read. The text below is its current content, which may differ from what the agent received.";
  if (coverage.certainty === ECoverageCertainty.Estimated) return "Highlights are estimated from the requested ranges; the tool's actual output was not recorded.";
  return "The text below may differ from what the agent received.";
}
