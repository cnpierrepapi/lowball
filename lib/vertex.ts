import { execSync } from "node:child_process";

// Gemini on Vertex over plain REST. In production a service account token is minted from
// GOOGLE_VERTEX_CREDENTIALS_B64; locally we borrow the gcloud login.
const PROJECT = process.env.GOOGLE_VERTEX_PROJECT ?? "syzygybot-ai";
const LOCATION = process.env.GOOGLE_VERTEX_LOCATION ?? "global";

let cached: { token: string; until: number } | undefined;

/** Credentials missing or refused. Not a hiccup: the shop can't think, so say so loudly. */
export class VertexConfigError extends Error {}

async function serviceAccountToken(b64: string): Promise<string> {
  const { GoogleAuth } = await import("google-auth-library");
  let credentials;
  try {
    credentials = JSON.parse(Buffer.from(b64, "base64").toString("utf8"));
  } catch {
    // Never pass the parse error on: it quotes the input, which is a private key.
    throw new VertexConfigError("GOOGLE_VERTEX_CREDENTIALS_B64 is not base64 service account JSON");
  }
  const auth = new GoogleAuth({
    credentials,
    scopes: ["https://www.googleapis.com/auth/cloud-platform"],
  });
  const t = await auth.getAccessToken();
  if (!t) throw new Error("service account returned no token");
  return t;
}

async function accessToken(): Promise<string> {
  if (cached && cached.until > Date.now()) return cached.token;
  const b64 = process.env.GOOGLE_VERTEX_CREDENTIALS_B64;
  if (!b64 && process.env.NODE_ENV === "production") throw new VertexConfigError("GOOGLE_VERTEX_CREDENTIALS_B64 is not set");
  let token: string;
  try {
    token = b64
      ? await serviceAccountToken(b64)
      : execSync("gcloud auth print-access-token", { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch (e) {
    if (e instanceof VertexConfigError) throw e;
    // Library messages can carry key material or token responses; keep only the error kind.
    throw new VertexConfigError(`no Vertex token (${(e as Error).name})`);
  }
  cached = { token, until: Date.now() + 45 * 60_000 };
  return token;
}

export interface Part {
  text?: string;
  inlineData?: { mimeType: string; data: string };
}

export async function generate(model: string, body: Record<string, unknown>, timeoutMs = 20_000) {
  const url = `https://aiplatform.googleapis.com/v1/projects/${PROJECT}/locations/${LOCATION}/publishers/google/models/${model}:generateContent`;
  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${await accessToken()}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const json = await res.json();
  if (res.status === 401 || res.status === 403) {
    cached = undefined;
    throw new VertexConfigError(`vertex ${model} ${res.status}: ${JSON.stringify(json).slice(0, 300)}`);
  }
  if (!res.ok) throw new Error(`vertex ${model} ${res.status}: ${JSON.stringify(json).slice(0, 300)}`);
  const parts: Part[] = json?.candidates?.[0]?.content?.parts ?? [];
  return { parts, usage: json?.usageMetadata };
}

/** Mints (or reuses) a token without spending anything on a model call. For /api/health. */
export async function vertexReady(): Promise<void> {
  await accessToken();
}

export function textOf(parts: Part[]): string {
  return parts.map((p) => p.text ?? "").join("").trim();
}
