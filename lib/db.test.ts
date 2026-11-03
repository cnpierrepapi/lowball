import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { testDb, wipe } from "./testing/pglite";
import { migrate, migrationFiles, statements } from "./migrate";
import { postgresStore } from "./games/store";
import type { Db } from "./db";

let db: Db;
beforeAll(async () => { db = await testDb(); }, 30_000);
beforeEach(async () => { await wipe(db); });

describe("migrations", () => {
  it("run each file once: a second run does nothing", async () => {
    const files = migrationFiles(new URL("../db", import.meta.url).pathname);
    expect(files.map((f) => f.name)).toEqual(["001_games.sql", "002_mail.sql", "003_shop.sql", "004_research.sql", "005_more_sources.sql", "006_solana.sql", "007_intents.sql"]);
    expect(await migrate(db, files)).toEqual([]);
    const ran = await db.query<{ name: string }>("SELECT name FROM schema_migrations ORDER BY name");
    expect(ran.map((r) => r.name)).toEqual(["001_games.sql", "002_mail.sql", "003_shop.sql", "004_research.sql", "005_more_sources.sql", "006_solana.sql", "007_intents.sql"]);
  });
  it("split a file into statements and drop comments", () => {
    expect(statements("-- note\nCREATE TABLE a (x int); -- trailing\n\nCREATE INDEX b ON a (x);\n")).toEqual(["CREATE TABLE a (x int)", "CREATE INDEX b ON a (x)"]);
  });
  it("a broken file leaves nothing half done", async () => {
    await expect(migrate(db, [{ name: "999_bad.sql", sql: "CREATE TABLE half (x int);\nTHIS IS NOT SQL;\n" }])).rejects.toThrow();
    expect(await db.query("SELECT to_regclass('half') AS t")).toEqual([{ t: null }]);
    expect(await db.query("SELECT name FROM schema_migrations WHERE name = '999_bad.sql'")).toEqual([]);
  });
});

describe("games on real Postgres", () => {
  const seed = "0123456789abcdef0123456789abcdef";
  it("start and finish are each single use, and tied to the haggle", async () => {
    const s = postgresStore(db);
    const id = randomUUID(), haggle = randomUUID();
    await s.offer({ id, haggle, kind: "snake", seed });
    expect(await s.start(id, randomUUID())).toBeUndefined();
    expect(await s.start(id, haggle)).toEqual({ kind: "snake", seed });
    expect(await s.start(id, haggle)).toBeUndefined();
    const p = await s.playing(id, haggle);
    expect(p).toMatchObject({ kind: "snake", seed, haggle });
    expect(p!.elapsedMs).toBeGreaterThanOrEqual(0);
    expect(await s.playing(id, randomUUID())).toBeUndefined();
    expect(await s.finish(id, 7, "scored")).toBe(true);
    expect(await s.finish(id, 9, "scored")).toBe(false);
    expect(await s.playing(id, haggle)).toBeUndefined();
    expect(await db.query("SELECT score, outcome FROM games")).toEqual([{ score: 7, outcome: "scored" }]);
  });
  it("can't finish a game that never started, or offer one id twice", async () => {
    const s = postgresStore(db);
    const id = randomUUID();
    await s.offer({ id, haggle: randomUUID(), kind: "stack", seed });
    expect(await s.finish(id, 3, "scored")).toBe(false);
    await expect(s.offer({ id, haggle: randomUUID(), kind: "stack", seed })).rejects.toThrow();
  });
});
