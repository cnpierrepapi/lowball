import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Db } from "./db";

// Runs the SQL files in db/ in name order, each once. Each file runs in one transaction with
// the note that it ran, so a half-applied file can't happen. Files only ever add things.

/** Splits a file into statements. Comments are dropped; statements end with ";" at line end. */
export function statements(sql: string): string[] {
  return sql
    .split("\n")
    .map((l) => l.replace(/--.*$/, "").trimEnd())
    .join("\n")
    .split(/;\s*$/m)
    .map((s) => s.trim())
    .filter(Boolean);
}

export function migrationFiles(dir: string): { name: string; sql: string }[] {
  return readdirSync(dir)
    .filter((f) => /^\d{3}_[a-z0-9_]+\.sql$/.test(f))
    .sort()
    .map((name) => ({ name, sql: readFileSync(join(dir, name), "utf8") }));
}

/** Applies what hasn't run yet. Returns the names it ran. */
export async function migrate(db: Db, files: { name: string; sql: string }[]): Promise<string[]> {
  await db.query("CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, ran_at timestamptz NOT NULL DEFAULT now())");
  const done = new Set((await db.query<{ name: string }>("SELECT name FROM schema_migrations")).map((r) => r.name));
  const ran: string[] = [];
  for (const f of files) {
    if (done.has(f.name)) continue;
    await db.transaction([...statements(f.sql).map((s): [string] => [s]), ["INSERT INTO schema_migrations (name) VALUES ($1)", [f.name]]]);
    ran.push(f.name);
  }
  return ran;
}
