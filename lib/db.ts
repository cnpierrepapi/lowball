import { neon } from "@neondatabase/serverless";

// The one door to Postgres. Only the server talks to the database; the browser never does.
// The app uses Neon over HTTP. Tests plug in PGlite (real Postgres, in memory) through setDb,
// so the same SQL runs in tests and in production.

export interface Db {
  /** One statement with $1, $2... parameters. Returns the rows. */
  query<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<T[]>;
  /** Several statements in one transaction: all happen or none do. Returns each one's rows. */
  transaction(steps: [string, unknown[]?][]): Promise<Record<string, unknown>[][]>;
}

export function neonDb(url: string): Db {
  const sql = neon(url);
  return {
    query: async <T,>(text: string, params: unknown[] = []) => (await sql.query(text, params)) as T[],
    transaction: async (steps) => (await sql.transaction(steps.map(([t, p]) => sql.query(t, p ?? [])))) as Record<string, unknown>[][],
  };
}

let override: Db | null | undefined;
let live: Db | undefined;

/** For tests: put a database in, or null for "no database". undefined goes back to the default. */
export function setDb(d: Db | null | undefined) {
  override = d;
}

/** The database, or undefined when DATABASE_URL isn't set. */
export function db(): Db | undefined {
  if (override !== undefined) return override ?? undefined;
  if (live) return live;
  const url = process.env.DATABASE_URL;
  if (!url) return undefined;
  live = neonDb(url);
  return live;
}

/** Health check: true if a trivial query comes back. */
export async function dbReady(): Promise<boolean> {
  const d = db();
  if (!d) return false;
  try {
    const rows = await d.query<{ one: number }>("select 1 as one");
    return Number(rows[0]?.one) === 1;
  } catch {
    return false;
  }
}

/** Health check: the tables the app needs exist (the build's migration step ran). */
export async function tablesReady(names: string[]): Promise<boolean> {
  const d = db();
  if (!d) return false;
  try {
    const rows = await d.query<{ missing: number }>(
      "SELECT count(*)::int AS missing FROM unnest($1::text[]) AS t(name) WHERE to_regclass(t.name) IS NULL",
      [names],
    );
    return Number(rows[0]?.missing) === 0;
  } catch {
    return false;
  }
}
