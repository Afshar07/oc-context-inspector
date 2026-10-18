import { EDeliverySource, type IDeliveredRead, type IToolResultLike } from "./types.js";

const HEADER = /^Read file .*, (?:lines (\d+)-(\d+)|(0) lines?)\s*$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** First line of the first text part of `result.content`: `Read file <path>, lines A-B`. */
function headerLine(content: unknown): string | undefined {
  const parts = typeof content === "string" ? [{ type: "text", text: content }] : Array.isArray(content) ? content : [];
  for (const part of parts) {
    if (isRecord(part) && part.type === "text" && typeof part.text === "string") {
      const newline = part.text.indexOf("\n");
      return newline === -1 ? part.text : part.text.slice(0, newline);
    }
  }
  return undefined;
}

/** Whether the tool says more of the file remains after what it returned; undefined when it does not say. */
function moreRemains(result: IToolResultLike): boolean | undefined {
  const output = isRecord(result.output) ? result.output : undefined;
  if (output && (output.next !== undefined || typeof output.truncated === "boolean")) {
    return output.next !== undefined || output.truncated === true;
  }
  const metadata = isRecord(result.metadata) ? result.metadata : undefined;
  return typeof metadata?.truncated === "boolean" ? metadata.truncated : undefined;
}

function delivered(source: EDeliverySource, start: number, end: number, more: boolean | undefined): IDeliveredRead | undefined {
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start) return undefined;
  // "No more" is only known when the tool said so: absence of the flag proves nothing.
  const reachedEof = more === false;
  return {
    source,
    lineCount: end - start + 1,
    range: { start, end },
    reachedEof,
    ...(reachedEof && { fileLines: end }),
  };
}

/**
 * The lines a successful `read` returned, from its result. Prefers the header the tool
 * prints (`Read file X, lines 30-39`); falls back to a paged result's `offset` plus its
 * line count. Undefined when neither is present, so callers fall back to the requested
 * range and say so. Reads numbers only; the result is never modified or stored.
 */
export function parseDelivery(result: IToolResultLike | undefined): IDeliveredRead | undefined {
  if (!result) return undefined;
  const more = moreRemains(result);

  const header = headerLine(result.content);
  const match = header === undefined ? null : HEADER.exec(header);
  if (match) {
    if (match[3] !== undefined) {
      return { source: EDeliverySource.Header, lineCount: 0, reachedEof: true, fileLines: 0 };
    }
    return delivered(EDeliverySource.Header, Number(match[1]), Number(match[2]), more);
  }

  const output = isRecord(result.output) ? result.output : undefined;
  if (output?.type === "text-page" && typeof output.content === "string" && typeof output.offset === "number") {
    const count = output.content === "" ? 0 : output.content.split("\n").length;
    if (count === 0) return undefined;
    return delivered(EDeliverySource.Page, output.offset, output.offset + count - 1, more);
  }
  return undefined;
}
