import { db } from "../db";
import { mailStore, type MailStore } from "./store";
import { dailyCap, mailer } from "./mailer";
import { drain } from "./outbox";

// The pieces the routes need, wired to the real database and mailer.

export function store(): MailStore | undefined {
  const d = db();
  return d && mailStore(d);
}

/** Sends what's waiting, briefly: used inside a request, so it gives up after a few seconds. */
export async function sendSoon(s: MailStore, budgetMs = 8_000) {
  try {
    return await drain(s, mailer(), { cap: dailyCap(), batch: 5, budgetMs });
  } catch (e) {
    // The email stays queued and the daily cron picks it up.
    console.error("mail send:", (e as Error).message);
    return undefined;
  }
}
