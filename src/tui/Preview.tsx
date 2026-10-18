/** @jsxImportSource @opentui/solid */
import type { Plugin } from "@opencode/plugin/tui";
import type { PanelInput } from "@opencode/plugin/tui/context";
import { createEffect, createResource, createSignal, For, onCleanup, Show } from "solid-js";
import { describeFile, isLineRead, STATUS_GLYPH } from "./format.js";
import type { ICoverageClient } from "./source.js";
import { statusColor } from "./theme.js";

export interface IPreviewProps {
  readonly ctx: Plugin.Context;
  readonly client: ICoverageClient;
  readonly panel: PanelInput;
  readonly filePath: string;
}

/** Session panel: the file as it is now, with the lines this session read marked and the rest dimmed. */
export function Preview(props: IPreviewProps) {
  const theme = props.ctx.theme;
  // Bumped by read events for this file, so the highlight follows the agent live.
  const [version, setVersion] = createSignal(0);
  createEffect(() => {
    const { sessionID } = props.panel;
    const filePath = props.filePath;
    onCleanup(
      props.client.onRead((event) => {
        if (event.sessionID === sessionID && event.filePath === filePath) setVersion((v) => v + 1);
      }),
    );
  });
  const [preview] = createResource(
    () => ({ sessionID: props.panel.sessionID, filePath: props.filePath, version: version() }),
    ({ sessionID, filePath }) => props.client.preview(sessionID, filePath),
  );

  props.ctx.keymap.layer(() => ({
    enabled: props.panel.focused,
    commands: [{ title: "Close context preview", bind: "escape", run: () => props.panel.close() }],
  }));

  const gutter = () => String(preview()?.lines.length ?? 0).length;

  return (
    <box flexDirection="column" flexGrow={1} paddingLeft={1} paddingRight={1}>
      <box flexDirection="row" gap={1} flexShrink={0}>
        <Show when={preview()}>
          {(p) => <text fg={statusColor(theme, p().coverage.status)}>{STATUS_GLYPH[p().coverage.status]}</text>}
        </Show>
        <text flexGrow={1} wrapMode="none" truncate fg={theme.text.base}>
          <b>{props.filePath}</b>
        </text>
        <Show when={preview()}>
          {(p) => <text fg={theme.text.muted}>{describeFile(p().coverage) || p().coverage.status}</text>}
        </Show>
      </box>
      <Show when={preview.error}>
        <text fg={theme.text.feedback.error.base}>{String(preview.error?.message ?? preview.error)}</text>
      </Show>
      <Show when={preview.state === "ready" && !preview()}>
        <text fg={theme.text.muted}>Not a context file of this project.</text>
      </Show>
      <Show when={preview()?.coverage.exists === false}>
        <text fg={theme.text.muted}>The file does not exist on disk.</text>
      </Show>
      <scrollbox flexGrow={1} focused={props.panel.focused}>
        <For each={preview()?.lines ?? []}>
          {(line, index) => {
            const read = () => isLineRead(index() + 1, preview()?.coverage.ranges ?? []);
            return (
              <box flexDirection="row" backgroundColor={read() ? theme.background.raised.base : undefined}>
                <text flexShrink={0} fg={read() ? theme.text.feedback.success.base : theme.text.faint}>
                  {read() ? "▌" : " "}
                  {String(index() + 1).padStart(gutter())}{" "}
                </text>
                <text wrapMode="none" fg={read() ? theme.text.base : theme.text.faint}>
                  {line}
                </text>
              </box>
            );
          }}
        </For>
        <Show when={preview()?.truncated}>
          <text fg={theme.text.muted}>… preview truncated</text>
        </Show>
      </scrollbox>
      <text flexShrink={0} fg={theme.text.faint}>
        ▌ read by the agent · dim: not read{preview()?.coverage.modifiedSinceRead ? " · file changed since it was read" : ""} · esc close
      </text>
    </box>
  );
}
