import { PGlite } from "@electric-sql/pglite";
import type { Db } from "../db";
import { migrate, migrationFiles } from "../migrate";

// Tests only: a real Postgres in memory, with every migration in db/ applied.
export async function testDb(): Promise<Db & { pg: PGlite }> {
  const pg = new PGlite();
  const d: Db & { pg: PGlite } = {
    pg,
    query: async <T,>(text: string, params: unknown[] = []) => (await pg.query(text, params)).rows as T[],
    transaction: (steps) =>
      pg.transaction(async (tx) => {
        const out: Record<string, unknown>[][] = [];
        for (const [t, p] of steps) out.push((await tx.query(t, p ?? [])).rows as Record<string, unknown>[]);
        return out;
      }),
  };
  await migrate(d, migrationFiles(new URL("../../db", import.meta.url).pathname));
  return d;
}

/** Empties every table the app owns, so one database can serve a whole test file. */
export async function wipe(d: Db): Promise<void> {
  await d.query("TRUNCATE subscribers, outbox, mail_days, games, holds, drops, packs, settings RESTART IDENTITY CASCADE");
}
