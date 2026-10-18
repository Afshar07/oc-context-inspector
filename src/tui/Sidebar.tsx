/** @jsxImportSource @opentui/solid */
import type { Plugin } from "@opencode/plugin/tui";
import { createEffect, createSignal, For, onCleanup, Show } from "solid-js";
import { describeFile, STATUS_GLYPH, summaryLine, trackingNote, visibleFiles } from "./format.js";
import type { ICoverageClient, ICoverageState } from "./source.js";
import { watchCoverage } from "./source.js";
import { statusColor } from "./theme.js";

export interface ISidebarProps {
  readonly ctx: Plugin.Context;
  readonly client: ICoverageClient;
  readonly sessionID: string;
  /** Unread files are hidden unless this is set. */
  readonly showUnread: boolean;
  /** Row highlighted by keyboard browsing, if browsing is active. */
  readonly cursor: number | undefined;
  readonly onOpen: (filePath: string) => void;
}

/** "Context files" section: every context file of the project and what this session read of it. */
export function Sidebar(props: ISidebarProps) {
  const theme = props.ctx.theme;
  const [state, setState] = createSignal<ICoverageState>({});
  createEffect(() => onCleanup(watchCoverage(props.client, props.sessionID, setState)));
  const allFiles = () => state().report?.files ?? [];
  const files = () => visibleFiles(allFiles(), props.showUnread);
  const hidden = () => allFiles().length - files().length;

  return (
    <Show when={allFiles().length > 0 || state().error}>
      <box flexDirection="column">
        <text fg={theme.text.base}>
          <b>Context files</b>
        </text>
        <Show when={state().report}>{(report) => <text fg={theme.text.muted}>{summaryLine(report())}</text>}</Show>
        <Show when={state().report && trackingNote(state().report!)}>
          {(note) => <text fg={theme.text.faint}>{note()}</text>}
        </Show>
        <Show when={state().error}>{(error) => <text fg={theme.text.feedback.error.base}>{error()}</text>}</Show>
        <For each={files()}>
          {(file, index) => (
            <box
              flexDirection="row"
              gap={1}
              backgroundColor={props.cursor === index() ? theme.background.raised.high : undefined}
              onMouseUp={() => props.onOpen(file.filePath)}
            >
              <text flexShrink={0} fg={statusColor(theme, file.status)}>
                {STATUS_GLYPH[file.status]}
              </text>
              <text flexGrow={1} wrapMode="none" truncate fg={file.exists ? theme.text.base : theme.text.muted}>
                {file.filePath}
              </text>
              <Show when={describeFile(file)}>
                {(detail) => (
                  <text flexShrink={0} fg={theme.text.muted}>
                    {detail()}
                  </text>
                )}
              </Show>
            </box>
          )}
        </For>
        <Show when={hidden() > 0}>
          <text fg={theme.text.faint}>
            {hidden()} unread hidden · /context-unread
          </text>
        </Show>
        <Show when={props.cursor !== undefined}>
          <text fg={theme.text.faint}>↑↓ select · enter preview · esc done</text>
        </Show>
      </box>
    </Show>
  );
}
