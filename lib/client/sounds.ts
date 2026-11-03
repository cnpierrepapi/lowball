// Short sound cues for shop events, synthesised in the browser (no audio files, no voice).
// Each cue is a few oscillator or noise notes with a fast decay, so they read as "events",
// not music, and stay out of the way of the words on screen.

export type Cue = "open" | "line" | "scoff" | "slam" | "deal" | "paid" | "door" | "point" | "crash";

export interface Sounds {
  play(cue: Cue): void;
  /** Browsers start audio suspended until a click; call this from one. */
  unlock(): void;
  setMuted(m: boolean): void;
}

export function createSounds(): Sounds {
  const ctx = new AudioContext();
  const out = ctx.createGain();
  out.gain.value = 0.5;
  out.connect(ctx.destination);
  let muted = false;

  // One note: a tone (or noise) that starts at `at` seconds from now and dies away.
  function note(o: { freq?: number; to?: number; type?: OscillatorType; at?: number; len: number; vol: number; noise?: boolean }) {
    const t = ctx.currentTime + (o.at ?? 0);
    const g = ctx.createGain();
    g.gain.setValueAtTime(o.vol, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + o.len);
    g.connect(out);
    if (o.noise) {
      const buf = ctx.createBuffer(1, Math.ceil(ctx.sampleRate * o.len), ctx.sampleRate);
      const data = buf.getChannelData(0);
      for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
      const src = ctx.createBufferSource();
      src.buffer = buf;
      const lp = ctx.createBiquadFilter();
      lp.type = "lowpass";
      lp.frequency.value = o.freq ?? 800;
      src.connect(lp).connect(g);
      src.start(t);
      return;
    }
    const osc = ctx.createOscillator();
    osc.type = o.type ?? "sine";
    osc.frequency.setValueAtTime(o.freq ?? 440, t);
    if (o.to) osc.frequency.exponentialRampToValueAtTime(o.to, t + o.len);
    osc.connect(g);
    osc.start(t);
    osc.stop(t + o.len + 0.02);
  }

  const cues: Record<Cue, () => void> = {
    // Shop bell over the door.
    open: () => {
      note({ freq: 1318, len: 0.5, vol: 0.25 });
      note({ freq: 988, at: 0.12, len: 0.7, vol: 0.25 });
    },
    // A quiet tick when she says something.
    line: () => note({ freq: 660, to: 520, type: "triangle", len: 0.07, vol: 0.08 }),
    // She scoffs at your number.
    scoff: () => note({ freq: 260, to: 150, type: "sawtooth", len: 0.22, vol: 0.07 }),
    // Fist on the counter.
    slam: () => {
      note({ freq: 110, to: 45, len: 0.35, vol: 0.6 });
      note({ noise: true, freq: 500, len: 0.15, vol: 0.4 });
    },
    // Handshake: the register rings.
    deal: () => {
      note({ noise: true, freq: 4000, len: 0.05, vol: 0.2 });
      note({ freq: 2093, at: 0.06, len: 0.6, vol: 0.18 });
      note({ freq: 2637, at: 0.14, len: 0.8, vol: 0.18 });
    },
    // Money landed: coins.
    paid: () => [1568, 2093, 2637, 3136].forEach((f, i) => note({ freq: f, at: i * 0.07, len: 0.35, vol: 0.14 })),
    // A point in a game: a short blip.
    point: () => note({ freq: 880, to: 1320, type: "square", len: 0.08, vol: 0.06 }),
    // Game over: a falling buzz.
    crash: () => note({ freq: 220, to: 70, type: "sawtooth", len: 0.4, vol: 0.12 }),
    // Thrown out: the door slams.
    door: () => {
      note({ freq: 90, to: 40, len: 0.5, vol: 0.7 });
      note({ noise: true, freq: 300, len: 0.3, vol: 0.5 });
    },
  };

  return {
    play(cue) {
      if (muted || ctx.state !== "running") return;
      cues[cue]();
    },
    unlock: () => void ctx.resume(),
    setMuted: (m) => { muted = m; },
  };
}

/**
 * Moves her mouth while a line is on screen, roughly one syllable every 90 ms, so she still
 * looks like she's talking without a voice. Returns a stop function.
 */
export function talkAlong(text: string, setTalk: (level: number) => void): () => void {
  const syllables = Math.max(2, Math.round(text.replace(/[^a-z]/gi, "").length / 3));
  let i = 0;
  const id = setInterval(() => {
    if (i++ >= syllables) {
      clearInterval(id);
      setTalk(0);
      return;
    }
    setTalk(i % 2 ? 0.35 + Math.random() * 0.5 : 0.05);
  }, 90);
  return () => {
    clearInterval(id);
    setTalk(0);
  };
}
