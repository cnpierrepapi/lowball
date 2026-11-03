// Runs before every build (npm run build). On Vercel, DATABASE_URL is set, so the database gets
// any new tables before the new code goes live. Locally without DATABASE_URL it does nothing.
import { neonDb } from "../lib/db.ts";
import { migrate, migrationFiles } from "../lib/migrate.ts";

const url = process.env.DATABASE_URL;
if (!url) {
  console.log("migrate: no DATABASE_URL, skipping");
} else {
  const ran = await migrate(neonDb(url), migrationFiles(new URL("../db", import.meta.url).pathname));
  console.log(ran.length ? `migrate: ran ${ran.join(", ")}` : "migrate: up to date");
}
