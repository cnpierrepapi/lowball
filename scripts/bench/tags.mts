// Voices one line per tag with the shop voice and saves it, to find tags that get read out loud.
import { writeFileSync, mkdirSync } from "node:fs";
import { speakAudio } from "../../lib/voice.ts";
const tags = (process.argv[2] ?? "sighs,scoffs,laughs,grumbling,whispers,shouting,suspicious,sarcastic,exasperated,pause,groans,dry").split(",");
mkdirSync("C:/tmp/tags", { recursive: true });
for (const tag of tags) {
  for (const pos of ["start", "mid"]) {
    const line = pos === "start" ? `[${tag}] Fine. One sixty, and not a cent less.` : `Fine. [${tag}] One sixty, and not a cent less.`;
    try {
      const a = await speakAudio(line);
      writeFileSync(`C:/tmp/tags/${tag}_${pos}.wav`, Buffer.from(a.data, "base64"));
    } catch (e) { console.log(tag, pos, "ERR", (e as Error).message.slice(0, 80)); }
  }
}
console.log("done");
