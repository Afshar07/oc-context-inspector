import type { ICoverageReport, IFilePreview } from "../types.js";

export interface IReadEvent {
  readonly sessionID: string;
  readonly filePath: string;
}

/** A model's answer, or why there is none (no provider, rate limit, ...). */
export type IAnalysisResult =
  | { readonly ok: true; readonly text: string; readonly model: string; readonly sessionCount?: number }
  | { readonly ok: false; readonly error: string };

/** What the TUI needs from the server; the RPC adapter is the only implementation. */
export interface ICoverageClient {
  coverage(sessionID: string): Promise<ICoverageReport>;
  /** Undefined when the path is not a context file. */
  preview(sessionID: string, filePath: string): Promise<IFilePreview | undefined>;
  onRead(handler: (event: IReadEvent) => void): () => void;
  /** Did this session read the context its task needed? `model`: `provider/model`, or the configured default. */
  analyzeSession(sessionID: string, model?: string): Promise<IAnalysisResult>;
  /** How all recorded sessions used the project's context files; `sessionID` only routes to the project. */
  reviewProject(sessionID: string, model?: string): Promise<IAnalysisResult>;
}

export interface ICoverageState {
  readonly report?: ICoverageReport;
  readonly error?: string;
}

/**
 * Keeps one session's report fresh: fetches now, then refetches after read events
 * for that session. Bursts of events collapse into one fetch, and a response that
 * arrives after a newer one is dropped. Returns a disposer.
 */
export function watchCoverage(
  client: ICoverageClient,
  sessionID: string,
  onUpdate: (state: ICoverageState) => void,
  delayMs = 150,
): () => void {
  let disposed = false;
  let latest = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const fetch = () => {
    const seq = ++latest;
    client.coverage(sessionID).then(
      (report) => !disposed && seq === latest && onUpdate({ report }),
      (error: unknown) =>
        !disposed && seq === latest && onUpdate({ error: error instanceof Error ? error.message : String(error) }),
    );
  };

  const unsubscribe = client.onRead((event) => {
    if (event.sessionID !== sessionID || timer !== undefined) return;
    timer = setTimeout(() => {
      timer = undefined;
      fetch();
    }, delayMs);
  });
  fetch();

  return () => {
    disposed = true;
    if (timer !== undefined) clearTimeout(timer);
    unsubscribe();
  };
}
