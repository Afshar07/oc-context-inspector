/**
 * The Markdown subset model answers use, parsed for plain OpenTUI elements.
 * OpenTUI's own <markdown> needs a SyntaxStyle from @opentui/core, which OpenCode
 * does not provide to plugins (importing it loads a second, conflicting copy).
 */

export interface IInline {
  readonly text: string;
  readonly bold?: true;
  readonly italic?: true;
  readonly code?: true;
}

export type IBlock =
  | { readonly kind: "heading"; readonly level: number; readonly inlines: readonly IInline[] }
  | { readonly kind: "item"; readonly level: number; readonly marker: string; readonly inlines: readonly IInline[] }
  | { readonly kind: "paragraph"; readonly inlines: readonly IInline[] }
  | { readonly kind: "code"; readonly lines: readonly string[] }
  | { readonly kind: "blank" };

const SPAN = /\*\*(.+?)\*\*|`([^`]+)`|\*([^*\s][^*]*?)\*|_([^_\s][^_]*?)_/g;

export function parseInline(text: string): IInline[] {
  const out: IInline[] = [];
  let last = 0;
  for (const m of text.matchAll(SPAN)) {
    if (m.index > last) out.push({ text: text.slice(last, m.index) });
    if (m[1] !== undefined) out.push({ text: m[1].replace(/`/g, ""), bold: true });
    else if (m[2] !== undefined) out.push({ text: m[2], code: true });
    else out.push({ text: (m[3] ?? m[4])!, italic: true });
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push({ text: text.slice(last) });
  return out;
}

export function parseMarkdown(text: string): IBlock[] {
  const blocks: IBlock[] = [];
  let code: string[] | undefined;
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*(```|~~~)/.test(line)) {
      if (code) {
        blocks.push({ kind: "code", lines: code });
        code = undefined;
      } else code = [];
      continue;
    }
    if (code) {
      code.push(line);
      continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    const item = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(line);
    if (heading) blocks.push({ kind: "heading", level: heading[1]!.length, inlines: parseInline(heading[2]!) });
    else if (item) {
      const marker = /\d/.test(item[2]!) ? item[2]! : "•";
      blocks.push({ kind: "item", level: Math.floor(item[1]!.length / 2), marker, inlines: parseInline(item[3]!) });
    } else if (line.trim() === "") blocks.push({ kind: "blank" });
    else blocks.push({ kind: "paragraph", inlines: parseInline(line.trim()) });
  }
  if (code) blocks.push({ kind: "code", lines: code });
  return blocks;
}
