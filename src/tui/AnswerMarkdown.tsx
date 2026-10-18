/** @jsxImportSource @opentui/solid */
import type { Plugin } from "@opencode/plugin/tui";
import { For, Match, Switch } from "solid-js";
import { type IBlock, type IInline, parseMarkdown } from "./markdown-parse.js";

const inline = (part: IInline) => (part.bold ? <b>{part.text}</b> : part.italic ? <i>{part.text}</i> : part.text);

/** Renders a model answer's Markdown with plain OpenTUI text, styled from the theme. */
export function AnswerMarkdown(props: { readonly text: string; readonly theme: Plugin.Context["theme"] }) {
  const md = () => props.theme.markdown;
  return (
    <box flexDirection="column">
      <For each={parseMarkdown(props.text)}>
        {(block: IBlock) => (
          <Switch>
            <Match when={block.kind === "heading" && block}>
              {(b) => (
                <text wrapMode="word" fg={md().heading}>
                  <b>
                    <For each={b().inlines}>{inline}</For>
                  </b>
                </text>
              )}
            </Match>
            <Match when={block.kind === "item" && block}>
              {(b) => (
                <box flexDirection="row" paddingLeft={b().level * 2}>
                  <text flexShrink={0} fg={md().listItem}>
                    {b().marker}{" "}
                  </text>
                  <text flexGrow={1} wrapMode="word" fg={props.theme.text.base}>
                    <For each={b().inlines}>{inline}</For>
                  </text>
                </box>
              )}
            </Match>
            <Match when={block.kind === "paragraph" && block}>
              {(b) => (
                <text wrapMode="word" fg={props.theme.text.base}>
                  <For each={b().inlines}>{inline}</For>
                </text>
              )}
            </Match>
            <Match when={block.kind === "code" && block}>
              {(b) => (
                <box flexDirection="column" paddingLeft={2}>
                  <For each={b().lines}>{(line) => <text wrapMode="none" fg={md().code}>{line || " "}</text>}</For>
                </box>
              )}
            </Match>
            <Match when={block.kind === "blank"}>
              <text> </text>
            </Match>
          </Switch>
        )}
      </For>
    </box>
  );
}
