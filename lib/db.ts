import { neon, type NeonQueryFunction } from "@neondatabase/serverless";

// Postgres on Neon, over HTTP. One query per call, no pool to manage on serverless.
// Returns undefined when DATABASE_URL isn't set, so callers can decide what that means.

let sql: NeonQueryFunction<false, false> | undefined;

export function db(): NeonQueryFunction<false, false> | undefined {
  if (sql) return sql;
  const url = process.env.DATABASE_URL;
  if (!url) return undefined;
  sql = neon(url);
  return sql;
}
