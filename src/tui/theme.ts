import type { Plugin } from "@opencode/plugin/tui";
import { ECoverageStatus } from "../types.js";

export function statusColor(theme: Plugin.Context["theme"], status: ECoverageStatus) {
  switch (status) {
    case ECoverageStatus.Full:
      return theme.text.feedback.success.base;
    case ECoverageStatus.Partial:
      return theme.text.feedback.warning.base;
    case ECoverageStatus.Error:
      return theme.text.feedback.error.base;
    case ECoverageStatus.AutoLoaded:
      return theme.text.feedback.info.base;
    case ECoverageStatus.Unread:
      return theme.text.faint;
    case ECoverageStatus.Unknown:
      return theme.text.muted;
  }
}
