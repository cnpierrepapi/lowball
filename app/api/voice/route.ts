import { NextRequest, NextResponse } from "next/server";
import { unseal } from "@/lib/seal";
import { speakAudio } from "@/lib/voice";

// Only lines the shop itself wrote (and sealed) can be voiced, so nobody can use this
// endpoint as free text-to-speech.
export async function POST(req: NextRequest) {
  const { token } = await req.json().catch(() => ({}));
  const line = unseal<string>("line", token);
  if (!line) return NextResponse.json({ error: "bad_line" }, { status: 400 });
  try {
    const audio = await speakAudio(line);
    return new NextResponse(Buffer.from(audio.data, "base64"), {
      headers: { "Content-Type": audio.mimeType.startsWith("audio/wav") ? "audio/wav" : audio.mimeType, "Cache-Control": "private, max-age=3600" },
    });
  } catch {
    return NextResponse.json({ error: "voice_unavailable" }, { status: 503 });
  }
}
