/** @jsxImportSource @opentui/solid */
import type { Plugin } from "@opencode/plugin/tui";
import type { PanelInput } from "@opencode/plugin/tui/context";
import { createResource, createSignal, Match, Switch } from "solid-js";
import { AnswerMarkdown } from "./AnswerMarkdown.js";
import type { ICoverageClient } from "./source.js";

export type EAnalysisMode = "session" | "project";

export interface IAnalysisProps {
  readonly ctx: Plugin.Context;
  readonly client: ICoverageClient;
  readonly panel: PanelInput;
  readonly mode: EAnalysisMode;
}

const TITLES: Readonly<Record<EAnalysisMode, string>> = {
  session: "Context analysis: this session",
  project: "Context review: all sessions",
};

/** Session panel: a model's reading of the recorded context usage. Runs once per open; `r` reruns. */
export function Analysis(props: IAnalysisProps) {
  const theme = props.ctx.theme;
  const [run, setRun] = createSignal(0);
  const [result] = createResource(
    () => ({ sessionID: props.panel.sessionID, mode: props.mode, run: run() }),
    ({ sessionID, mode }) =>
      mode === "session" ? props.client.analyzeSession(sessionID) : props.client.reviewProject(sessionID),
  );

  props.ctx.keymap.layer(() => ({
    enabled: props.panel.focused,
    commands: [
      { title: "Close analysis", bind: "escape", run: () => props.panel.close() },
      { title: "Run analysis again", bind: "r", run: () => void (result.loading || setRun((n) => n + 1)) },
    ],
  }));

  return (
    <box flexDirection="column" flexGrow={1} paddingLeft={1} paddingRight={1}>
      <text flexShrink={0} fg={theme.text.base}>
        <b>{TITLES[props.mode]}</b>
      </text>
      <scrollbox flexGrow={1} focused={props.panel.focused}>
        <Switch>
          <Match when={result.loading}>
            <text fg={theme.text.muted}>Asking the model…</text>
          </Match>
          <Match when={result.error}>
            <text fg={theme.text.feedback.error.base}>{String(result.error?.message ?? result.error)}</text>
          </Match>
          <Match when={result()}>
            {(r) => {
              const answer = r();
              return answer.ok ? (
                <AnswerMarkdown text={answer.text} theme={theme} />
              ) : (
                <text wrapMode="word" fg={theme.text.feedback.error.base}>
                  Analysis failed: {answer.error}
                </text>
              );
            }}
          </Match>
        </Switch>
      </scrollbox>
      <text flexShrink={0} fg={theme.text.faint}>
        {(() => {
          const r = result();
          const model = r?.ok ? `${r.model} · ` : "";
          const sessions = r?.ok && r.sessionCount !== undefined ? `${r.sessionCount} sessions · ` : "";
          return `${model}${sessions}r rerun · esc close`;
        })()}
      </text>
    </box>
  );
}
