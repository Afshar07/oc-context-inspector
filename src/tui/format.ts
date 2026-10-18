import { ECoverageStatus, type ICoverageReport, type IFileCoverage, type ILineRange } from "../types.js";

export const STATUS_GLYPH: Readonly<Record<ECoverageStatus, string>> = {
  [ECoverageStatus.Full]: "●",
  [ECoverageStatus.Partial]: "◐",
  [ECoverageStatus.Unread]: "○",
  [ECoverageStatus.AutoLoaded]: "◌",
  [ECoverageStatus.Error]: "✕",
};

const coveredLines = (ranges: readonly ILineRange[]) => ranges.reduce((n, r) => n + r.end - r.start + 1, 0);

/** Short right-hand detail for one sidebar row; empty when the glyph says it all. */
export function describeFile(file: IFileCoverage): string {
  const parts: string[] = [];
  switch (file.status) {
    case ECoverageStatus.Error:
      parts.push(file.exists ? "read failed" : "missing");
      break;
    case ECoverageStatus.AutoLoaded:
      parts.push("auto-loaded");
      break;
    case ECoverageStatus.Partial: {
      const [only] = file.ranges;
      parts.push(
        file.ranges.length === 1 && only
          ? `L${only.start}–${only.end}/${file.lineCount}`
          : `${coveredLines(file.ranges)}/${file.lineCount} lines`,
      );
      break;
    }
    case ECoverageStatus.Full:
    case ECoverageStatus.Unread:
      break;
  }
  if (file.readCount > 1) parts.push(`${file.readCount}×`);
  if (file.modifiedSinceRead) parts.push("changed");
  return parts.join(" · ");
}

/** "2/5 read": files with at least one successful read, out of files that exist. */
export function summaryLine(report: ICoverageReport): string {
  const existing = report.files.filter((f) => f.exists);
  return `${existing.filter((f) => f.readCount > 0).length}/${existing.length} read`;
}

export function isLineRead(line: number, ranges: readonly ILineRange[]): boolean {
  return ranges.some((r) => line >= r.start && line <= r.end);
}

/** Sidebar rows: unread files are hidden unless asked for; auto-loaded ones stay, the model saw them. */
export function visibleFiles(files: readonly IFileCoverage[], showUnread: boolean): readonly IFileCoverage[] {
  return showUnread ? files : files.filter((f) => f.status !== ECoverageStatus.Unread);
}
