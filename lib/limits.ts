import type { NextRequest } from "next/server";

// Sliding-window caps, in memory. On serverless each instance counts on its own, so this is a
// brake on one noisy client, not a wall; the firewall rate rule is the wall.
const hits = new Map<string, number[]>();

export function clientIp(req: NextRequest): string {
  return req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || req.headers.get("x-real-ip") || "local";
}

/** True if `key` is still under `max` hits per `windowMs`; records the hit when it is. */
export function allow(key: string, max: number, windowMs: number, now = Date.now()): boolean {
  const recent = (hits.get(key) ?? []).filter((t) => t > now - windowMs);
  if (recent.length >= max) {
    hits.set(key, recent);
    return false;
  }
  recent.push(now);
  hits.set(key, recent);
  if (hits.size > 10_000) {
    // Drop the oldest keys so an address sweep can't grow this without bound.
    for (const k of [...hits.keys()].slice(0, 5_000)) hits.delete(k);
  }
  return true;
}
