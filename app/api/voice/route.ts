import { NextRequest, NextResponse } from "next/server";
import { createHash } from "node:crypto";
import { readVoiceToken, speakAudio, voiceText } from "@/lib/voice";
import { allow, clientIp } from "@/lib/limits";
import { VertexConfigError } from "@/lib/vertex";

// Only lines the shop itself wrote (and sealed) can be voiced, so nobody can use this
// endpoint as free text-to-speech. A GET, so the same line is cached at the edge.
// Usage: <audio src="/api/voice?t=<voice token>">

// Recent audio on this instance, by the exact text sent to the model.
const recent = new Map<string, { body: Buffer; type: string }>();
const KEEP = 64;

export async function GET(req: NextRequest) {
  const line = readVoiceToken(req.nextUrl.searchParams.get("t"));
  if (!line) return NextResponse.json({ error: "bad_line" }, { status: 400 });
  const key = createHash("sha256").update(voiceText(line)).digest("hex");

  let audio = recent.get(key);
  if (!audio) {
    const ip = clientIp(req);
    if (!allow(`voice:${ip}`, 20, 60_000) || !allow(`voice-h:${ip}`, 150, 3_600_000)) {
      return NextResponse.json({ error: "slow_down" }, { status: 429, headers: { "Retry-After": "30" } });
    }
    try {
      const a = await speakAudio(line);
      audio = { body: Buffer.from(a.data, "base64"), type: a.mimeType.startsWith("audio/wav") ? "audio/wav" : a.mimeType };
    } catch (e) {
      if (e instanceof VertexConfigError) console.error("voice: vertex config:", e.message);
      return NextResponse.json({ error: "voice_unavailable" }, { status: 503 });
    }
    recent.set(key, audio);
    if (recent.size > KEEP) recent.delete(recent.keys().next().value!);
  }
  return new NextResponse(new Uint8Array(audio.body), {
    headers: {
      "Content-Type": audio.type,
      // The URL holds the exact line, so its audio never needs to change.
      "Cache-Control": "public, max-age=86400, s-maxage=86400, immutable",
      ETag: `"${key.slice(0, 16)}"`,
    },
  });
}
