import Anthropic from "@anthropic-ai/sdk";
import { ConfigError } from "./config";

// The shopkeeper's brain is Claude. The key comes from ANTHROPIC_API_KEY. The client is made
// on first use, so a missing key shows up as a clear config error on the first turn (and on
// /api/health) instead of crashing the whole server at import.

/** Key missing or refused. Not a hiccup: the shop can't think, so say so loudly. */
export class ModelConfigError extends ConfigError {}

// Fast and cheap for the two calls every haggle turn makes. Overridable per environment.
export const TURN_MODEL = process.env.LOWBALL_TURN_MODEL ?? "claude-haiku-5-5";

let client: Anthropic | undefined;

export function claude(): Anthropic {
  if (client) return client;
  if (!process.env.ANTHROPIC_API_KEY) throw new ModelConfigError("ANTHROPIC_API_KEY is not set");
  // A haggle turn should never hang: one retry, short timeout.
  client = new Anthropic({ timeout: 20_000, maxRetries: 1 });
  return client;
}

/**
 * Turns auth failures into ModelConfigError and passes everything else on. Messages carry
 * only the status, never the response body, which can echo request details.
 */
export function asConfigError(e: unknown): unknown {
  if (e instanceof Anthropic.AuthenticationError || e instanceof Anthropic.PermissionDeniedError) {
    return new ModelConfigError(`Claude refused the key (${e.status})`);
  }
  return e;
}

/** All the text blocks of a reply, joined. */
export function textOf(msg: Anthropic.Message): string {
  return msg.content
    .map((b) => (b.type === "text" ? b.text : ""))
    .join("")
    .trim();
}

let readyUntil = 0;

/**
 * Checks the key really works, without spending anything: looking up a model is free.
 * Cached for a minute so health checks don't hammer the API.
 */
export async function claudeReady(): Promise<void> {
  if (readyUntil > Date.now()) return;
  try {
    await claude().models.retrieve(TURN_MODEL);
  } catch (e) {
    throw asConfigError(e);
  }
  readyUntil = Date.now() + 60_000;
}
