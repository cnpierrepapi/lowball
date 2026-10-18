import { execSync } from "node:child_process";

// Gemini on Vertex over plain REST. In production a service account token is minted from
// GOOGLE_VERTEX_CREDENTIALS_B64; locally we borrow the gcloud login.
const PROJECT = process.env.GOOGLE_VERTEX_PROJECT ?? "syzygybot-ai";
const LOCATION = process.env.GOOGLE_VERTEX_LOCATION ?? "global";

let cached: { token: string; until: number } | undefined;

async function serviceAccountToken(b64: string): Promise<string> {
  const { GoogleAuth } = await import("google-auth-library");
  const auth = new GoogleAuth({
    credentials: JSON.parse(Buffer.from(b64, "base64").toString("utf8")),
    scopes: ["https://www.googleapis.com/auth/cloud-platform"],
  });
  const t = await auth.getAccessToken();
  if (!t) throw new Error("service account returned no token");
  return t;
}

async function accessToken(): Promise<string> {
  if (cached && cached.until > Date.now()) return cached.token;
  const b64 = process.env.GOOGLE_VERTEX_CREDENTIALS_B64;
  const token = b64
    ? await serviceAccountToken(b64)
    : execSync("gcloud auth print-access-token", { encoding: "utf8" }).trim();
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
  if (!res.ok) throw new Error(`vertex ${model} ${res.status}: ${JSON.stringify(json).slice(0, 300)}`);
  const parts: Part[] = json?.candidates?.[0]?.content?.parts ?? [];
  return { parts, usage: json?.usageMetadata };
}

export function textOf(parts: Part[]): string {
  return parts.map((p) => p.text ?? "").join("").trim();
}
