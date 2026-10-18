import type { IModelRef } from "./types.js";

/** `provider/model` or `provider/model#variant`, as OpenCode writes model IDs. */
export function parseModelRef(value: unknown): IModelRef | undefined {
  if (typeof value !== "string") return undefined;
  const match = /^([^/#\s]+)\/([^#\s]+)(?:#(\S+))?$/.exec(value);
  if (!match) return undefined;
  return { providerID: match[1]!, id: match[2]!, ...(match[3] !== undefined && { variant: match[3] }) };
}

export function formatModelRef(m: IModelRef): string {
  return `${m.providerID}/${m.id}${m.variant ? `#${m.variant}` : ""}`;
}
