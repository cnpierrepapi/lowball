import { createHash, randomUUID } from "node:crypto";
import type { Db } from "../db";
import { dropPhase, type Phase } from "../engine/drops";

// Packs, drops and the copies held for buyers. Only the server touches these tables.

export interface Pack {
  id: string;
  title: string;
  blurb: string;
  teaser: string;
  body: string;
  score: number;
  leadId: string | null;
  hash: string;
  onchainTx: string | null;
  createdAt: string;
}

export interface Drop {
  id: string;
  packId: string;
  title: string;
  blurb: string;
  score: number;
  copies: number;
  sold: number;
  held: number;
  opensAt: string;
  closesAt: string;
  cancelled: boolean;
  phase: Phase;
}

/** sha256 of the pack's words, the fingerprint that goes onchain later. */
export function packHash(p: Pick<Pack, "id" | "title" | "blurb" | "teaser" | "body">): string {
  return createHash("sha256").update(JSON.stringify([p.id, p.title, p.blurb, p.teaser, p.body])).digest("hex");
}

/**
 * How long a copy stays set aside after a handshake: the 5 minutes the signed offer is good for,
 * plus the 2 minutes a payment may take to settle, plus a minute of slack. A payment can't land
 * after its hold has run out.
 */
export const HOLD_MS = 8 * 60_000;

const iso = (v: unknown) => new Date(v as string).toISOString();

function packFrom(r: Record<string, unknown>): Pack {
  return {
    id: String(r.id), title: String(r.title), blurb: String(r.blurb), teaser: String(r.teaser), body: String(r.body),
    score: Number(r.score), leadId: (r.lead_id as string) ?? null, hash: String(r.hash),
    onchainTx: (r.onchain_tx as string) ?? null, createdAt: iso(r.created_at),
  };
}

function dropFrom(r: Record<string, unknown>, now: number): Drop {
  const d = {
    id: String(r.id), packId: String(r.pack_id), title: String(r.title), blurb: String(r.blurb), score: Number(r.score),
    copies: Number(r.copies), sold: Number(r.sold), held: Number(r.held),
    opensAt: iso(r.opens_at), closesAt: iso(r.closes_at), cancelled: r.cancelled_at != null,
  };
  return {
    ...d,
    phase: dropPhase({ copies: d.copies, taken: d.sold + d.held, opensAt: Date.parse(d.opensAt), closesAt: Date.parse(d.closesAt), cancelled: d.cancelled }, now),
  };
}

const DROP_SELECT = `
  SELECT d.id, d.pack_id, d.copies, d.opens_at, d.closes_at, d.cancelled_at, p.title, p.blurb, p.score,
         count(h.nonce) FILTER (WHERE h.sold_at IS NOT NULL)::int AS sold,
         count(h.nonce) FILTER (WHERE h.sold_at IS NULL AND h.released_at IS NULL)::int AS held
  FROM drops d JOIN packs p ON p.id = d.pack_id LEFT JOIN holds h ON h.drop_id = d.id`;

export type IsPaid = (nonce: string) => Promise<boolean>;

export function shopStore(db: Db) {
  const s = {
    async addPack(p: Omit<Pack, "hash" | "onchainTx" | "createdAt">): Promise<Pack> {
      const hash = packHash(p);
      const rows = await db.query(
        `INSERT INTO packs (id, title, blurb, teaser, body, score, lead_id, hash) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
        [p.id, p.title, p.blurb, p.teaser, p.body, p.score, p.leadId, hash],
      );
      return packFrom(rows[0]);
    },

    async pack(id: string): Promise<Pack | undefined> {
      const rows = await db.query("SELECT * FROM packs WHERE id = $1", [id]);
      return rows[0] ? packFrom(rows[0]) : undefined;
    },

    async packs(): Promise<Pack[]> {
      return (await db.query("SELECT * FROM packs ORDER BY created_at DESC")).map(packFrom);
    },

    /** The hook for the onchain record: called once the pack's hash is written onchain. */
    async setOnchainTx(packId: string, tx: string): Promise<void> {
      await db.query("UPDATE packs SET onchain_tx = $2 WHERE id = $1 AND onchain_tx IS NULL", [packId, tx]);
    },

    /** Puts a pack on sale. Fails if the pack doesn't exist, is already dropped, or the times are wrong. */
    async schedule(d: { packId: string; copies: number; opensAt: Date; closesAt: Date }): Promise<Drop> {
      const id = randomUUID();
      await db.query("INSERT INTO drops (id, pack_id, copies, opens_at, closes_at) VALUES ($1, $2, $3, $4, $5)", [id, d.packId, d.copies, d.opensAt, d.closesAt]);
      return (await s.drop(id, Date.now()))!;
    },

    /** Calls off a drop that hasn't opened yet. */
    async cancel(id: string, now: Date): Promise<boolean> {
      const rows = await db.query("UPDATE drops SET cancelled_at = $2 WHERE id = $1 AND cancelled_at IS NULL AND opens_at > $2 RETURNING id", [id, now]);
      return rows.length === 1;
    },

    async drop(id: string, now: number): Promise<Drop | undefined> {
      const rows = await db.query(`${DROP_SELECT} WHERE d.id = $1 GROUP BY d.id, p.id`, [id]);
      return rows[0] ? dropFrom(rows[0], now) : undefined;
    },

    /** The live (not cancelled) drop for a pack, if there is one. */
    async dropForPack(packId: string, now: number): Promise<Drop | undefined> {
      const rows = await db.query(`${DROP_SELECT} WHERE d.pack_id = $1 AND d.cancelled_at IS NULL GROUP BY d.id, p.id`, [packId]);
      return rows[0] ? dropFrom(rows[0], now) : undefined;
    },

    async drops(now: number): Promise<Drop[]> {
      const rows = await db.query(`${DROP_SELECT} GROUP BY d.id, p.id ORDER BY d.opens_at DESC`);
      return rows.map((r) => dropFrom(r, now));
    },

    /**
     * Settles holds whose time ran out: paid ones become sold, unpaid ones go back on the shelf.
     * If the chain can't be asked right now, the hold stays taken (never oversell).
     */
    async reconcile(dropId: string, now: Date, isPaid: IsPaid): Promise<void> {
      const due = await db.query<{ nonce: string }>(
        "SELECT nonce FROM holds WHERE drop_id = $1 AND sold_at IS NULL AND released_at IS NULL AND expires_at <= $2",
        [dropId, now],
      );
      for (const { nonce } of due) {
        let paid: boolean;
        try {
          paid = await isPaid(nonce);
        } catch {
          continue;
        }
        await db.query(`UPDATE holds SET ${paid ? "sold_at" : "released_at"} = $2 WHERE nonce = $1`, [nonce, now]);
      }
    },

    /**
     * Sets a copy aside for a handshake. Only while the drop is open and a copy is free; the lock
     * makes two handshakes for the last copy take turns, so only one gets it.
     */
    async hold(dropId: string, nonce: string, price: number, now: Date, isPaid: IsPaid): Promise<boolean> {
      await s.reconcile(dropId, now, isPaid);
      const [, rows] = await db.transaction([
        ["SELECT pg_advisory_xact_lock(hashtext($1))", [`drop:${dropId}`]],
        [
          `INSERT INTO holds (nonce, drop_id, price, created_at, expires_at)
           SELECT $1, $2, $3, $4, $5
           WHERE EXISTS (
             SELECT 1 FROM drops d
             WHERE d.id = $2 AND d.cancelled_at IS NULL AND d.opens_at <= $4 AND d.closes_at > $4
               AND (SELECT count(*) FROM holds h WHERE h.drop_id = d.id AND h.released_at IS NULL) < d.copies
           )
           ON CONFLICT (nonce) DO NOTHING
           RETURNING nonce`,
          [nonce, dropId, price, now, new Date(now.getTime() + HOLD_MS)],
        ],
      ]);
      return rows.length === 1;
    },

    /** Marks a hold sold as soon as its payment is seen, so the count is right before it expires. */
    async markSold(nonce: string, now: Date): Promise<void> {
      await db.query("UPDATE holds SET sold_at = $2 WHERE nonce = $1 AND sold_at IS NULL AND released_at IS NULL", [nonce, now]);
    },

    async setting(key: string): Promise<string | undefined> {
      const rows = await db.query<{ value: string }>("SELECT value FROM settings WHERE key = $1", [key]);
      return rows[0]?.value;
    },

    async setSetting(key: string, value: string): Promise<void> {
      await db.query("INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value", [key, value]);
    },

    /** Sets a setting only if it has never been set. True if this call set it. */
    async setSettingOnce(key: string, value: string): Promise<boolean> {
      const rows = await db.query("INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO NOTHING RETURNING key", [key, value]);
      return rows.length === 1;
    },
  };
  return s;
}

export type ShopStore = ReturnType<typeof shopStore>;
