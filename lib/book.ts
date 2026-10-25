import { readFile } from "node:fs/promises";
import { join } from "node:path";

// Items are markdown files in /content. They're read at runtime, so next.config traces the
// folder into the functions that need it.
export function readItemFile(file: string): Promise<string> {
  if (!/^[a-z0-9-]+\.md$/.test(file)) throw new Error("bad item file");
  return readFile(join(process.cwd(), "content", file), "utf8");
}

/** The free sample: the front matter and contents, then the opening of chapter 1. */
export function sampleOf(md: string, paragraphs = 4): string {
  const start = md.indexOf("\n## Chapter 1");
  if (start < 0) return md.slice(0, 1500);
  const rest = md.slice(start).split(/\n\n+/);
  return `${md.slice(0, start)}\n${rest.slice(0, paragraphs + 1).join("\n\n")}\n\n*...the rest is behind the counter.*`;
}
