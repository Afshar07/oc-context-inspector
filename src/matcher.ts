import * as path from "node:path";
import type { IContextInspectorOptions } from "./types.js";

export const DEFAULT_CONTEXT_PATHS: readonly string[] = ["AGENTS.md", ".ai/**"];

interface ICompiledPattern {
  readonly source: string;
  readonly regex: RegExp;
  /** Patterns without a slash match the basename at any depth, like gitignore. */
  readonly basenameOnly: boolean;
}

function escapeRegex(ch: string): string {
  return /[.+^${}()|[\]\\]/.test(ch) ? `\\${ch}` : ch;
}

function globToRegex(glob: string): string {
  let out = "";
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i]!;
    if (ch === "*") {
      if (glob[i + 1] === "*") {
        const slash = glob[i + 2] === "/";
        out += slash ? "(?:.*/)?" : ".*";
        i += slash ? 2 : 1;
      } else {
        out += "[^/]*";
      }
    } else if (ch === "?") {
      out += "[^/]";
    } else {
      out += escapeRegex(ch);
    }
  }
  return `^${out}$`;
}

export class ContextPathMatcher {
  private readonly patterns: readonly ICompiledPattern[];

  constructor(
    private readonly root: string,
    contextPaths: IContextInspectorOptions["contextPaths"],
  ) {
    this.patterns = contextPaths.map((raw) => {
      const source = raw.replace(/^\.\//, "");
      const basenameOnly = !source.includes("/");
      const alternatives = [globToRegex(source)];
      // `dir/**` also matches the directory itself, so listing `.ai` is a context read.
      if (source.endsWith("/**")) alternatives.push(globToRegex(source.slice(0, -3)));
      return { source: raw, basenameOnly, regex: new RegExp(alternatives.join("|")) };
    });
  }

  /** Project-relative POSIX path, or undefined when the file is outside the project. */
  relativize(filePath: string): string | undefined {
    const abs = path.resolve(this.root, filePath);
    const rel = path.relative(this.root, abs);
    if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) return undefined;
    return rel.split(path.sep).join("/");
  }

  /** Absolute path of a project-relative one. */
  resolve(relPath: string): string {
    return path.resolve(this.root, relPath);
  }

  /** Returns the matching pattern and normalized path, or undefined when not context. */
  match(filePath: string): { readonly relPath: string; readonly pattern: string } | undefined {
    const relPath = this.relativize(filePath);
    if (relPath === undefined) return undefined;
    const base = relPath.slice(relPath.lastIndexOf("/") + 1);
    for (const p of this.patterns) {
      if (p.regex.test(p.basenameOnly ? base : relPath)) return { relPath, pattern: p.source };
    }
    return undefined;
  }
}
