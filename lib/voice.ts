import { generate } from "./vertex";

export const VOICE_MODEL = process.env.LOWBALL_VOICE_MODEL ?? "gemini-3.8-flash-tts";
export const VOICE = process.env.LOWBALL_VOICE ?? "Gacrux";

// Style lives in inline [tags]. A "say it like..." prefix gets read out loud by this model,
// and so, now and then, does a tag in the middle of a line (seen with [whispers] and
// [sarcastic]; 0 of 12 opening tags leaked in testing). So only the opening tags are kept.
export function voiceText(line: string): string {
  const lead = line.match(/^\s*(\[[^\]]*\]\s*)+/)?.[0] ?? "";
  const rest = line.slice(lead.length).replace(/\[[^\]]*\]\s*/g, "");
  return (lead.trim() + " " + rest.replace(/\s{2,}/g, " ").trim()).trim();
}

export async function speakAudio(taggedLine: string): Promise<{ mimeType: string; data: string }> {
  const { parts } = await generate(
    VOICE_MODEL,
    {
      contents: [{ role: "user", parts: [{ text: voiceText(taggedLine).slice(0, 400) }] }],
      generationConfig: {
        responseModalities: ["AUDIO"],
        speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: VOICE } } },
      },
    },
    30_000,
  );
  const audio = parts.find((p) => p.inlineData)?.inlineData;
  if (!audio) throw new Error("no audio returned");
  return audio;
}
