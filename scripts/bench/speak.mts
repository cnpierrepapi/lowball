import { generate, textOf } from "../../lib/vertex.ts";
const prompt = `You are the shopkeeper of Lowball, gruff, sarcastic, theatrical. Selling an ebook. The buyer offered 0.50. Come down a little to 1.88 USDC and make it clear it hurts. One or two short sentences, under 30 words, prices as digits, you may use voice tags like [sighs] [scoffs]. Reply with the line only.`;
for (const [model, cfg] of [
  ["gemini-3.8-flash", { thinkingConfig: { thinkingLevel: "low" }, maxOutputTokens: 400 }],
  ["gemini-3.8-flash", { thinkingConfig: { thinkingLevel: "low" }, maxOutputTokens: 2000 }],
  ["gemini-3.5-flash-lite", { maxOutputTokens: 300 }],
  ["gemini-3.5-flash-lite", { thinkingConfig: { thinkingLevel: "minimal" }, maxOutputTokens: 300 }],
] as const) {
  for (let i = 0; i < 2; i++) {
    const t = Date.now();
    try {
      const r: any = await generate(model, { contents: [{ role: "user", parts: [{ text: prompt }] }], generationConfig: { temperature: 0.9, ...cfg } });
      console.log(model, JSON.stringify(cfg).slice(0, 60), Date.now() - t, "ms |", JSON.stringify(r.usage?.thoughtsTokenCount ?? 0), "thoughts |", textOf(r.parts));
    } catch (e: any) { console.log(model, "ERR", e.message.slice(0, 200)); }
  }
}
