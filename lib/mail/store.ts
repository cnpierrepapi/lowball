import type { Db } from "../db";
import { hashToken, newNonce, tokenFor } from "./tokens";
import type { DropInfo } from "./templates";

// Everything the mail feature does to the database. Each rule that matters is one statement
// (or one transaction), so two requests at once can't break it. Times are passed in, so tests
// can move the clock.

export type SignupResult = "new" | "resend" | "nothing";

export interface Claimed {
  id: number;
  email: string;
  kind: "confirm" | "drop";
  drop?: DropInfo;
  confirmNonce: string | null;
  unsubNonce: string;
}

export const RESEND_AFTER = "1 hour";
export const CONFIRM_VALID = "7 days";
export const MAX_ATTEMPTS = 3;
/** A claimed email that never got marked sent (the server died mid-send) can go again after this. */
export const RECLAIM_AFTER = "10 minutes";

export function mailStore(db: Db) {
  return {
    /**
     * Saves a signup and queues its confirmation. A new address gets a row. An unconfirmed one
     * whose last confirmation went out over an hour ago gets a fresh link (the old one stops
     * working). Anything else changes nothing. The caller says the same thing either way.
     */
    async signup(email: string, now: Date): Promise<SignupResult> {
      const confirmNonce = newNonce();
      const unsubNonce = newNonce();
      const [rows] = await db.transaction([
        [
          `INSERT INTO subscribers (email, created_at, confirm_nonce, confirm_hash, confirm_sent_at, unsub_nonce, unsub_hash)
           VALUES ($1, $2, $3, $4, $2, $5, $6)
           ON CONFLICT (email) DO UPDATE
             SET confirm_nonce = EXCLUDED.confirm_nonce, confirm_hash = EXCLUDED.confirm_hash, confirm_sent_at = EXCLUDED.confirm_sent_at
             WHERE subscribers.confirmed = false AND subscribers.confirm_sent_at <= $2::timestamptz - interval '${RESEND_AFTER}'
           RETURNING (xmax = 0) AS inserted`,
          [email, now, confirmNonce, hashToken(tokenFor("confirm", confirmNonce)), unsubNonce, hashToken(tokenFor("unsub", unsubNonce))],
        ],
        // Queue the confirmation only if the line above just wrote this nonce.
        [
          `INSERT INTO outbox (email, kind, drop_id, created_at)
           SELECT $1, 'confirm', '', $2 WHERE EXISTS (SELECT 1 FROM subscribers WHERE email = $1 AND confirm_nonce = $3)
           ON CONFLICT (email, kind, drop_id) DO UPDATE
             SET created_at = EXCLUDED.created_at, claimed_at = NULL, sent_at = NULL, attempts = 0, last_error = NULL`,
          [email, now, confirmNonce],
        ],
      ]);
      if (rows.length === 0) return "nothing";
      return rows[0].inserted ? "new" : "resend";
    },

    /** Confirms the address this token belongs to. Works once, within 7 days of sending. */
    async confirm(token: string, now: Date): Promise<boolean> {
      const rows = await db.query(
        `UPDATE subscribers SET confirmed = true, confirmed_at = $2, confirm_nonce = NULL, confirm_hash = NULL
         WHERE confirm_hash = $1 AND confirmed = false AND confirm_sent_at > $2::timestamptz - interval '${CONFIRM_VALID}'
         RETURNING email`,
        [hashToken(token), now],
      );
      return rows.length === 1;
    },

    /** Deletes the address this token belongs to, and everything queued for it. */
    async unsubscribe(token: string): Promise<boolean> {
      const rows = await db.query("DELETE FROM subscribers WHERE unsub_hash = $1 RETURNING email", [hashToken(token)]);
      return rows.length === 1;
    },

    /** Queues a drop email for every confirmed subscriber, once per drop. Returns how many were queued. */
    async announce(drop: DropInfo, now: Date): Promise<number> {
      const rows = await db.query(
        `INSERT INTO outbox (email, kind, drop_id, drop_info, created_at)
         SELECT email, 'drop', $1, $2::jsonb, $3 FROM subscribers WHERE confirmed
         ON CONFLICT (email, kind, drop_id) DO NOTHING
         RETURNING id`,
        [drop.id, JSON.stringify(drop), now],
      );
      return rows.length;
    },

    /**
     * Takes up to `batch` waiting emails to send now, never more than today's cap allows.
     * Confirmations go first. A drop email only goes to a confirmed address, a confirmation only
     * to an unconfirmed one. The lock makes two senders at once take turns, so the count can't
     * be raced past the cap.
     */
    async claim(cap: number, batch: number, now: Date): Promise<Claimed[]> {
      const [, rows] = await db.transaction([
        ["SELECT pg_advisory_xact_lock(727274)"],
        [
          `WITH used AS (
             SELECT coalesce((SELECT sent FROM mail_days WHERE day = ($1::timestamptz AT TIME ZONE 'UTC')::date), 0) AS n
           ),
           pick AS (
             SELECT o.id FROM outbox o JOIN subscribers s ON s.email = o.email
             WHERE o.sent_at IS NULL AND o.attempts < ${MAX_ATTEMPTS}
               AND (o.claimed_at IS NULL OR o.claimed_at < $1::timestamptz - interval '${RECLAIM_AFTER}')
               AND ((o.kind = 'confirm' AND NOT s.confirmed AND s.confirm_nonce IS NOT NULL) OR (o.kind = 'drop' AND s.confirmed))
             ORDER BY (o.kind = 'confirm') DESC, o.created_at, o.id
             LIMIT least($3::int, greatest($2::int - (SELECT n FROM used), 0))
             FOR UPDATE OF o SKIP LOCKED
           ),
           upd AS (
             UPDATE outbox SET claimed_at = $1, attempts = attempts + 1
             WHERE id IN (SELECT id FROM pick)
             RETURNING id, email, kind, drop_info
           ),
           bump AS (
             INSERT INTO mail_days (day, sent)
             SELECT ($1::timestamptz AT TIME ZONE 'UTC')::date, count(*) FROM upd HAVING count(*) > 0
             ON CONFLICT (day) DO UPDATE SET sent = mail_days.sent + EXCLUDED.sent
           )
           SELECT upd.id, upd.email, upd.kind, upd.drop_info, s.confirm_nonce, s.unsub_nonce
           FROM upd JOIN subscribers s ON s.email = upd.email
           ORDER BY (upd.kind = 'confirm') DESC, upd.id`,
          [now, cap, batch],
        ],
      ]);
      return rows.map((r) => ({
        id: Number(r.id),
        email: String(r.email),
        kind: r.kind as Claimed["kind"],
        drop: (typeof r.drop_info === "string" ? JSON.parse(r.drop_info) : r.drop_info) ?? undefined,
        confirmNonce: (r.confirm_nonce as string | null) ?? null,
        unsubNonce: String(r.unsub_nonce),
      }));
    },

    async sent(id: number, now: Date): Promise<void> {
      await db.query("UPDATE outbox SET sent_at = $2, last_error = NULL WHERE id = $1", [id, now]);
    },

    async failed(id: number, error: string): Promise<void> {
      await db.query("UPDATE outbox SET last_error = $2 WHERE id = $1", [id, error.slice(0, 300)]);
    },

    /** Emails counted against the cap on the UTC day of `now`. */
    async sentOn(now: Date): Promise<number> {
      const rows = await db.query<{ sent: number }>("SELECT sent FROM mail_days WHERE day = ($1::timestamptz AT TIME ZONE 'UTC')::date", [now]);
      return Number(rows[0]?.sent ?? 0);
    },

    async waiting(): Promise<number> {
      const rows = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM outbox WHERE sent_at IS NULL AND attempts < ${MAX_ATTEMPTS}`);
      return Number(rows[0]?.n ?? 0);
    },
  };
}

export type MailStore = ReturnType<typeof mailStore>;
