/** @jsxImportSource @opentui/solid */
import type { Plugin } from "@opencode/plugin/tui";
import type { PanelInput } from "@opencode/plugin/tui/context";
import { createResource, createSignal, For, Match, Switch } from "solid-js";
import type { IExperimentClient } from "./experiment-client.js";
import { evaluationLines } from "./evaluation-format.js";
import { toneColor } from "./theme.js";

export interface IEvaluationProps {
  readonly ctx: Plugin.Context;
  readonly client: IExperimentClient;
  readonly panel: PanelInput;
  readonly experimentId: string;
}

/** Session panel: baseline against candidate for one experiment. Computed locally on open; `r` refreshes. */
export function Evaluation(props: IEvaluationProps) {
  const theme = props.ctx.theme;
  const [run, setRun] = createSignal(0);
  const [data] = createResource(
    () => ({ sessionID: props.panel.sessionID, id: props.experimentId, run: run() }),
    async ({ sessionID, id }) => {
      const result = await props.client.evaluate(sessionID, id);
      if (!result.ok) return result;
      const { experiments } = await props.client.list(sessionID);
      return { ok: true as const, lines: evaluationLines(result.value, experiments.find((e) => e.id === id)) };
    },
  );

  props.ctx.keymap.layer(() => ({
    enabled: props.panel.focused,
    commands: [
      { title: "Close evaluation", bind: "escape", run: () => props.panel.close() },
      { title: "Refresh evaluation", bind: "r", run: () => void (data.loading || setRun((n) => n + 1)) },
    ],
  }));

  return (
    <box flexDirection="column" flexGrow={1} paddingLeft={1} paddingRight={1}>
      <text flexShrink={0} fg={theme.text.base}>
        <b>Context experiment: evaluation</b>
      </text>
      <scrollbox flexGrow={1} focused={props.panel.focused}>
        <Switch>
          <Match when={data.loading}>
            <text fg={theme.text.muted}>Measuring…</text>
          </Match>
          <Match when={data.error}>
            <text fg={theme.text.feedback.error.base}>{String(data.error?.message ?? data.error)}</text>
          </Match>
          <Match when={data()}>
            {(d) => {
              const value = d();
              return value.ok ? (
                <For each={value.lines}>
                  {(line) => (
                    <text wrapMode="word" fg={toneColor(theme, line.tone)}>
                      {line.bold ? <b>{line.text || " "}</b> : line.text || " "}
                    </text>
                  )}
                </For>
              ) : (
                <text wrapMode="word" fg={theme.text.feedback.error.base}>
                  Evaluation failed: {value.error}
                </text>
              );
            }}
          </Match>
        </Switch>
      </scrollbox>
      <text flexShrink={0} fg={theme.text.faint}>
        Observed measurements come from recorded reads; human-labeled ones from your labels · r refresh · esc close
      </text>
    </box>
  );
}
