import { randomBytes, scrypt as scryptCb, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import type { NextRequest } from "next/server";
import { db } from "./db";
import { shopStore } from "./shop/store";
import { seal, unseal } from "./seal";

// The admin dashboard's lock. The password is never in the code (the repo is public): the
// first visit sets it, and only a slow scrypt hash of it is kept, in the database.

const scrypt = promisify(scryptCb) as (pw: string, salt: Buffer, len: number) => Promise<Buffer>;
export const COOKIE = "lowball_admin";
export const SESSION_SECONDS = 12 * 3600;
export const MIN_PASSWORD = 8;

export async function hashPassword(pw: string): Promise<string> {
  const salt = randomBytes(16);
  const h = await scrypt(pw, salt, 32);
  return `scrypt$${salt.toString("base64")}$${h.toString("base64")}`;
}

export async function checkPassword(pw: string, stored: string): Promise<boolean> {
  const [kind, salt, hash] = stored.split("$");
  if (kind !== "scrypt" || !salt || !hash) return false;
  const want = Buffer.from(hash, "base64");
  const got = await scrypt(pw, Buffer.from(salt, "base64"), want.length);
  return got.length === want.length && timingSafeEqual(got, want);
}

/** Is a password set yet? */
export async function passwordSet(): Promise<boolean> {
  const d = db();
  return Boolean(d && (await shopStore(d).setting("admin_password")));
}

/**
 * Logs in, or sets the password if none is set yet (first visit only: the database refuses a
 * second set). Returns a sealed session for the cookie, or undefined.
 */
export async function login(pw: unknown, now = Date.now()): Promise<string | undefined> {
  const d = db();
  if (!d || typeof pw !== "string" || pw.length < MIN_PASSWORD || pw.length > 200) return undefined;
  const store = shopStore(d);
  let stored = await store.setting("admin_password");
  if (!stored) {
    await store.setSettingOnce("admin_password", await hashPassword(pw));
    stored = await store.setting("admin_password"); // whoever won the race, check against that
  }
  if (!stored || !(await checkPassword(pw, stored))) return undefined;
  return seal("admin", { exp: Math.floor(now / 1000) + SESSION_SECONDS });
}

export function isAdmin(req: NextRequest, now = Date.now()): boolean {
  const s = unseal<{ exp: number }>("admin", req.cookies.get(COOKIE)?.value);
  return Boolean(s && s.exp > now / 1000);
}
