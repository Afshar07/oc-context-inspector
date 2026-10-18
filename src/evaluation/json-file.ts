import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import * as path from "node:path";

export type JsonRead<T> =
  | { readonly status: "ok"; readonly value: T }
  | { readonly status: "missing" }
  /** The file exists but is not valid JSON, or fails `accept`: half-written, hand-edited or from another schema. */
  | { readonly status: "corrupt" };

const isMissing = (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT";
// Windows refuses to rename over a file another process is reading for a moment.
const isBusy = (error: unknown) => ["EPERM", "EBUSY", "EACCES"].includes((error as NodeJS.ErrnoException).code ?? "");

/** Reads a JSON file; never throws for a missing or unparseable file. `accept` narrows the parsed value. */
export async function readJsonFile<T>(file: string, accept: (value: unknown) => value is T): Promise<JsonRead<T>> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    if (isMissing(error)) return { status: "missing" };
    throw error;
  }
  try {
    const value: unknown = JSON.parse(text);
    return accept(value) ? { status: "ok", value } : { status: "corrupt" };
  } catch {
    return { status: "corrupt" };
  }
}

/** Writes through a temporary file and a rename, so a reader sees the old or the new content, never a torn one. */
export async function writeJsonAtomic(file: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  await writeFile(tmp, JSON.stringify(value));
  try {
    for (let attempt = 0; ; attempt++) {
      try {
        await rename(tmp, file);
        return;
      } catch (error) {
        if (!isBusy(error) || attempt >= 5) throw error;
        await new Promise((resolve) => setTimeout(resolve, 20 * (attempt + 1)));
      }
    }
  } catch (error) {
    await rm(tmp, { force: true }).catch(() => {});
    throw error;
  }
}

/** Creates `file` only if it does not exist (content-addressed files are written once). Returns whether it was created. */
export async function writeJsonOnce(file: string, value: unknown): Promise<boolean> {
  await mkdir(path.dirname(file), { recursive: true });
  try {
    await writeFile(file, JSON.stringify(value), { flag: "wx" });
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  }
}
