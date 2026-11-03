import { siteUrl } from "../site";
import type { MailStore, Claimed } from "./store";
import type { Mailer } from "./mailer";
import { confirmEmail, dropEmail, type DropInfo, type Email } from "./templates";
import { tokenFor } from "./tokens";

// Sending what's waiting, under the daily cap. Called right after a signup (so the confirmation
// goes out at once), right after a drop is announced, and once a day by the cron for whatever
// didn't fit under yesterday's cap.

export function render(c: Claimed, site = siteUrl()): Email | undefined {
  if (c.kind === "confirm") {
    if (!c.confirmNonce) return undefined;
    return confirmEmail(`${site}/confirm?t=${tokenFor("confirm", c.confirmNonce)}`);
  }
  if (!c.drop) return undefined;
  return dropEmail(c.drop, { shop: `${site}/`, unsubscribe: `${site}/unsubscribe?t=${tokenFor("unsub", c.unsubNonce)}` });
}

export interface DrainResult {
  sent: number;
  failed: number;
  waiting: number;
}

export async function drain(
  store: MailStore,
  mailer: Mailer,
  o: { cap: number; batch?: number; now?: () => Date; budgetMs?: number; site?: string },
): Promise<DrainResult> {
  const now = o.now ?? (() => new Date());
  const started = Date.now();
  let sent = 0;
  let failed = 0;
  while (Date.now() - started < (o.budgetMs ?? 40_000)) {
    const batch = await store.claim(o.cap, o.batch ?? 10, now());
    if (batch.length === 0) break;
    for (const c of batch) {
      const email = render(c, o.site);
      try {
        if (!email) throw new Error("nothing to send");
        await mailer.send(c.email, email);
        await store.sent(c.id, now());
        sent++;
      } catch (e) {
        await store.failed(c.id, (e as Error).message);
        failed++;
      }
    }
  }
  return { sent, failed, waiting: await store.waiting() };
}

/**
 * A drop got scheduled: queue its email for every confirmed subscriber and start sending.
 * Announcing the same drop twice queues nothing new.
 */
export async function announceDrop(
  store: MailStore,
  mailer: Mailer,
  drop: DropInfo,
  o: { cap: number; now?: () => Date; site?: string },
): Promise<{ queued: number } & DrainResult> {
  const queued = await store.announce(drop, (o.now ?? (() => new Date()))());
  return { queued, ...(await drain(store, mailer, o)) };
}
