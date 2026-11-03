import { resolveMx, resolve4, resolve6 } from "node:dns/promises";

// Checks an address before it goes anywhere near the database.

export function normalizeEmail(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const e = raw.trim().toLowerCase();
  if (e.length > 254) return undefined;
  // One @, something before it, a dotted domain after it, no spaces or angle brackets.
  const m = /^([a-z0-9!#$%&'*+/=?^_`{|}~.-]{1,64})@([a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,63})$/.exec(e);
  if (!m) return undefined;
  const [, local, domain] = m;
  if (local.startsWith(".") || local.endsWith(".") || local.includes("..")) return undefined;
  if (domain.split(".").some((part) => part.startsWith("-") || part.endsWith("-") || part.length > 63)) return undefined;
  return e;
}

export type Lookup = (domain: string) => Promise<boolean | undefined>;

/**
 * Can this domain receive mail? true or false when DNS answers, undefined when it doesn't
 * answer in time (then the address is let through rather than turning people away).
 */
export const dnsLookup: Lookup = async (domain) => {
  const answer = async (): Promise<boolean> => {
    try {
      if ((await resolveMx(domain)).length > 0) return true;
    } catch (e) {
      const code = (e as { code?: string }).code;
      if (code !== "ENODATA" && code !== "ENOTFOUND") throw e;
      if (code === "ENOTFOUND") return false; // the domain doesn't exist
    }
    // No MX record: mail can still go to the domain's own address.
    for (const r of [resolve4, resolve6]) {
      try {
        if ((await r(domain)).length > 0) return true;
      } catch {
        // try the next
      }
    }
    return false;
  };
  const timeout = new Promise<undefined>((ok) => setTimeout(() => ok(undefined), 2000));
  return Promise.race([answer().catch(() => undefined), timeout]);
};

let lookupOverride: Lookup | undefined;
/** For tests, which shouldn't depend on the network. */
export function setEmailLookup(l: Lookup | undefined) {
  lookupOverride = l;
}

/** The checked, lowercased address, or undefined if it isn't one. */
export async function checkEmail(raw: unknown, lookup: Lookup = lookupOverride ?? dnsLookup): Promise<string | undefined> {
  const e = normalizeEmail(raw);
  if (!e) return undefined;
  const ok = await lookup(e.split("@")[1]);
  return ok === false ? undefined : e;
}
