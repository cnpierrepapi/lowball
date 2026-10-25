// Plays the shopkeeper's lines and reports how loud he is, so his mouth moves with the words.
export interface Voice {
  play(token: string): Promise<void>;
  unlock(): void;
  setMuted(m: boolean): void;
}

export function createVoice(onLevel: (level: number) => void): Voice {
  const ctx = new AudioContext();
  const gain = ctx.createGain();
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 512;
  analyser.connect(gain).connect(ctx.destination);
  const buf = new Uint8Array(analyser.fftSize);
  let current: AudioBufferSourceNode | null = null;
  let raf = 0;
  let generation = 0;

  const meter = () => {
    analyser.getByteTimeDomainData(buf);
    let sum = 0;
    for (const v of buf) sum += ((v - 128) / 128) ** 2;
    onLevel(Math.min(1, Math.sqrt(sum / buf.length) * 5));
    raf = requestAnimationFrame(meter);
  };

  return {
    async play(token) {
      const mine = ++generation;
      const res = await fetch(`/api/voice?t=${token}`);
      if (!res.ok || mine !== generation) return; // no voice is fine; the words are on screen
      const audio = await ctx.decodeAudioData(await res.arrayBuffer());
      if (mine !== generation) return; // a newer line already started
      current?.stop();
      const src = ctx.createBufferSource();
      src.buffer = audio;
      src.connect(analyser);
      src.onended = () => {
        if (current === src) {
          cancelAnimationFrame(raf);
          onLevel(0);
        }
      };
      current = src;
      src.start();
      cancelAnimationFrame(raf);
      meter();
    },
    unlock: () => void ctx.resume(),
    setMuted: (m) => { gain.gain.value = m ? 0 : 1; },
  };
}
