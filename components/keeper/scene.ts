import * as THREE from "three";

// The shopkeeper, built in code: faceted low-poly head, fedora, brows, eyes and a mustache that
// all move with his mood and his voice. Flat shading plus a per-face colour jitter gives the
// cut-paper look of the cover art. No model files.

export interface Keeper {
  /** -1 furious .. 0 grumpy .. 1 pleased. Eases toward the target. */
  setMood(m: number): void;
  /** 0 silent .. 1 shouting. Drive it from the voice's loudness. */
  setTalk(level: number): void;
  /** Pointer in normalised screen coordinates, -1..1. */
  lookAt(x: number, y: number): void;
  /** A quick reaction: a scoff tilts the head back, a slam drops the brows hard. */
  react(kind: "scoff" | "slam" | "nod"): void;
  dispose(): void;
}

const SKIN = new THREE.Color("#e9a87c");
const SKIN_SHADE = new THREE.Color("#c27a50");
const HAT = new THREE.Color("#3d3631");
const HAIR = new THREE.Color("#2a211d");

/** Gives every triangle its own colour: a lit-from-the-front gradient plus a little jitter. */
function paintFacets(geo: THREE.BufferGeometry, base: THREE.Color, shade: THREE.Color, seed = 1) {
  const g = geo.index ? geo.toNonIndexed() : geo;
  g.computeVertexNormals();
  const pos = g.getAttribute("position");
  const colors = new Float32Array(pos.count * 3);
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), n = new THREE.Vector3();
  let s = seed;
  const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  const col = new THREE.Color();
  for (let i = 0; i < pos.count; i += 3) {
    a.fromBufferAttribute(pos, i); b.fromBufferAttribute(pos, i + 1); c.fromBufferAttribute(pos, i + 2);
    n.subVectors(c, b).cross(a.clone().sub(b)).normalize();
    // Faces turned away from the viewer (and downward) take the darker tone.
    const side = Math.min(1, Math.abs(n.x) * 0.9 + Math.max(0, -n.y) * 0.6);
    col.copy(base).lerp(shade, side * 0.85 + (rnd() - 0.5) * 0.18);
    for (let k = 0; k < 3; k++) colors.set([col.r, col.g, col.b], (i + k) * 3);
  }
  g.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  return g;
}

/** A faceted head: a coarse icosphere pushed into a square jaw, a chin, cheekbones and a brow ridge. */
function headGeometry() {
  const g = new THREE.IcosahedronGeometry(1, 1);
  const p = g.getAttribute("position");
  const v = new THREE.Vector3();
  for (let i = 0; i < p.count; i++) {
    v.fromBufferAttribute(p, i);
    let { x, y, z } = v;
    y *= 1.18;
    if (y < 0) {
      // Square jaw: sides stay wide until low, then cut in to a blunt chin.
      const t = Math.min(1, -y / 1.18);
      x *= 1 - 0.18 * t - 0.25 * t * t * t;
      y -= 0.14 * t * t;
      if (z > 0.4) z += 0.08 * t; // chin pushes forward
    }
    if (y > -0.2 && y < 0.3 && Math.abs(x) > 0.6) x *= 1.07; // cheekbones
    if (y > 0.2 && y < 0.6 && z > 0.5) z += 0.1; // brow ridge
    if (y > 0.7) y *= 0.94; // flatter crown under the hat
    z *= z < 0 ? 0.85 : 1.06;
    p.setXYZ(i, x, y, z);
  }
  return paintFacets(g, SKIN, SKIN_SHADE, 7);
}

function noseGeometry() {
  // A wedge: wide at the base, sharp ridge, pointing out and down.
  const g = new THREE.BufferGeometry();
  const v = [
    0, 0.32, 0.02, // bridge top
    -0.17, -0.2, 0, // left nostril
    0.17, -0.2, 0, // right nostril
    0, -0.24, 0.3, // tip
    0, -0.27, 0.02, // under
  ];
  const idx = [0, 1, 3, 0, 3, 2, 1, 4, 3, 3, 4, 2];
  g.setAttribute("position", new THREE.Float32BufferAttribute(v, 3));
  g.setIndex(idx);
  return paintFacets(g, SKIN, SKIN_SHADE, 3);
}

function mustacheGeometry() {
  // Half a handlebar, mirrored. Thick in the middle, curling up at the ends.
  const pts: [number, number][] = [
    [0, 0.02], [0.18, 0.04], [0.36, 0.0], [0.5, -0.06], [0.6, -0.02], [0.66, 0.08],
    [0.6, 0.0], [0.5, -0.13], [0.34, -0.15], [0.16, -0.1], [0, -0.07],
  ];
  const all = [...pts, ...pts.slice(1, -1).reverse().map(([x, y]) => [-x, y] as [number, number])];
  const shape = new THREE.Shape(all.map(([x, y]) => new THREE.Vector2(x, y)));
  const g = new THREE.ExtrudeGeometry(shape, { depth: 0.12, bevelEnabled: true, bevelSize: 0.03, bevelThickness: 0.04, bevelSegments: 1 });
  g.translate(0, 0, -0.06);
  return paintFacets(g, HAIR, new THREE.Color("#120e0c"), 5);
}

function hatGroup() {
  const group = new THREE.Group();
  const flat = (geo: THREE.BufferGeometry, base: THREE.Color, seed: number) =>
    new THREE.Mesh(paintFacets(geo, base, new THREE.Color("#1c1815"), seed),
      new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 0.85 }));
  // Crown with a pinched top: an 8-sided cylinder whose top ring is pulled in at the front.
  const crown = new THREE.CylinderGeometry(0.74, 0.96, 0.82, 8, 2, false);
  const cp = crown.getAttribute("position");
  for (let i = 0; i < cp.count; i++) {
    const y = cp.getY(i);
    if (y > 0.3) {
      cp.setY(i, y - 0.12 * Math.max(0, cp.getZ(i))); // dent toward the front
      cp.setX(i, cp.getX(i) * 0.92);
    }
  }
  const crownMesh = flat(crown, HAT, 11);
  crownMesh.position.y = 0.42;
  const band = flat(new THREE.CylinderGeometry(0.985, 0.995, 0.16, 8), new THREE.Color("#7a2a1c"), 13);
  band.position.y = 0.1;
  const brim = flat(new THREE.CylinderGeometry(1.38, 1.32, 0.08, 10), HAT, 17);
  brim.scale.z = 0.95;
  group.add(crownMesh, band, brim);
  return group;
}

export function createKeeper(canvas: HTMLCanvasElement): Keeper {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, preserveDrawingBuffer: true });
  renderer.setPixelRatio(Math.min(2, window.devicePixelRatio));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(30, 1, 0.1, 50);
  camera.position.set(0, 0.25, 7.2);

  // Warm key from the upper left, cool fill, a peach rim from behind (the cover's circle).
  scene.add(new THREE.HemisphereLight("#fff4e6", "#c98d6a", 1.1));
  const key = new THREE.DirectionalLight("#fff1dc", 2.4);
  key.position.set(-3, 4, 5);
  const fill = new THREE.DirectionalLight("#cfe0ff", 0.6);
  fill.position.set(4, 0, 3);
  const rim = new THREE.DirectionalLight("#ffb48a", 1.6);
  rim.position.set(2, 3, -4);
  scene.add(key, fill, rim);

  const skinMat = new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 0.78 });
  const darkMat = new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 0.9 });

  const root = new THREE.Group(); // whole body: breathing
  const head = new THREE.Group(); // turns and tilts
  root.add(head);
  scene.add(root);

  const skull = new THREE.Mesh(headGeometry(), skinMat);
  head.add(skull);
  // Features sit on the actual face, found by casting a ray at it from the front.
  const ray = new THREE.Raycaster();
  const surfaceZ = (x: number, y: number) => {
    ray.set(new THREE.Vector3(x, y, 5), new THREE.Vector3(0, 0, -1));
    return ray.intersectObject(skull)[0]?.point.z ?? 1;
  };

  const nose = new THREE.Mesh(noseGeometry(), skinMat);
  nose.position.set(0, -0.08, surfaceZ(0, -0.08) - 0.03);
  head.add(nose);

  // Ears: flattened low-poly blobs.
  for (const sx of [-1, 1]) {
    const ear = new THREE.Mesh(paintFacets(new THREE.IcosahedronGeometry(0.2, 0), SKIN, SKIN_SHADE, 19), skinMat);
    ear.scale.set(0.55, 1.1, 0.9);
    ear.position.set(sx * 0.93, 0.02, -0.05);
    head.add(ear);
  }

  // Eyes: a small eyeball with a big dark iris, set into the face, under a rounded lid that
  // rotates down. Resting half-shut: he's not impressed.
  const eyeWhite = new THREE.MeshStandardMaterial({ color: "#f3ebe0", roughness: 0.45 });
  const irisMat = new THREE.MeshStandardMaterial({ color: "#21160f", roughness: 0.3 });
  const glintMat = new THREE.MeshBasicMaterial({ color: "#ffffff" });
  const lidMat = new THREE.MeshStandardMaterial({ color: "#c47a4e", flatShading: true, roughness: 0.85 });
  const eyes = [-1, 1].map((sx) => {
    const g = new THREE.Group();
    g.position.set(sx * 0.34, 0.15, surfaceZ(sx * 0.34, 0.15) - 0.06);
    g.rotation.y = sx * 0.22;
    const ball = new THREE.Mesh(new THREE.SphereGeometry(0.15, 12, 8), eyeWhite);
    ball.scale.set(1.15, 0.9, 1);
    const iris = new THREE.Group();
    const irisDisc = new THREE.Mesh(new THREE.SphereGeometry(0.095, 10, 6), irisMat);
    irisDisc.scale.z = 0.45;
    const glint = new THREE.Mesh(new THREE.SphereGeometry(0.018, 6, 4), glintMat);
    glint.position.set(-0.025, 0.03, 0.04);
    iris.add(irisDisc, glint);
    iris.position.z = 0.115;
    // Upper lid: the top half of a slightly bigger sphere, pivoting at the eye's centre.
    const lid = new THREE.Mesh(new THREE.SphereGeometry(0.17, 10, 5, 0, Math.PI * 2, 0, Math.PI / 2), lidMat);
    lid.scale.set(1.15, 0.95, 1.05);
    g.add(ball, iris, lid);
    head.add(g);
    return { g, iris, lid, sx };
  });

  // Brows: chunky wedges, thick at the inner end. Mood rotates them (angry = inner ends down).
  const brows = [-1, 1].map((sx) => {
    const geo = new THREE.BoxGeometry(0.46, 0.15, 0.16, 2, 1, 1);
    const bp = geo.getAttribute("position");
    for (let i = 0; i < bp.count; i++) {
      const out = bp.getX(i) * sx; // + toward the temple
      if (out > 0) bp.setY(i, bp.getY(i) * 0.5 - 0.02);
    }
    const m = new THREE.Mesh(paintFacets(geo, HAIR, new THREE.Color("#0e0b0a"), 23), darkMat);
    m.position.set(sx * 0.35, 0.4, surfaceZ(sx * 0.35, 0.4) + 0.02);
    m.rotation.y = sx * 0.25;
    head.add(m);
    return { m, sx };
  });

  const mustache = new THREE.Mesh(mustacheGeometry(), darkMat);
  mustache.position.set(0, -0.36, surfaceZ(0, -0.36) + 0.02);
  mustache.rotation.x = -0.15;
  head.add(mustache);

  // Mouth: a rounded dark opening with a tongue, hidden behind the mustache until he talks.
  const mouth = new THREE.Group();
  const cavity = new THREE.Mesh(new THREE.CylinderGeometry(0.17, 0.17, 0.08, 8), new THREE.MeshStandardMaterial({ color: "#3b1310", roughness: 1 }));
  cavity.rotation.x = Math.PI / 2;
  cavity.scale.set(1.25, 1, 0.55);
  const tongue = new THREE.Mesh(new THREE.SphereGeometry(0.1, 8, 4, 0, Math.PI * 2, 0, Math.PI / 2), new THREE.MeshStandardMaterial({ color: "#b54a43", flatShading: true, roughness: 0.7 }));
  tongue.scale.set(1.3, 0.5, 0.6);
  tongue.position.set(0, -0.075, 0.02);
  mouth.add(cavity, tongue);
  mouth.position.set(0, -0.5, surfaceZ(0, -0.5) - 0.02);
  head.add(mouth);

  const hat = hatGroup();
  hat.position.set(0, 0.88, -0.02);
  hat.rotation.set(-0.08, 0, 0.06);
  head.add(hat);

  // Neck and shoulders: a white collar under a dark vest, enough to seat the head.
  const torsoGeo = new THREE.CylinderGeometry(0.9, 1.45, 1.4, 7, 1);
  const torso = new THREE.Mesh(paintFacets(torsoGeo, new THREE.Color("#3b3330"), new THREE.Color("#1d1917"), 29), darkMat);
  torso.position.y = -1.95;
  const neck = new THREE.Mesh(paintFacets(new THREE.CylinderGeometry(0.55, 0.62, 0.55, 7), SKIN, SKIN_SHADE, 31), skinMat);
  neck.position.y = -1.15;
  const collar = new THREE.Mesh(paintFacets(new THREE.CylinderGeometry(0.68, 0.8, 0.3, 7), new THREE.Color("#f4ede2"), new THREE.Color("#c9bfb2"), 37), skinMat);
  collar.position.y = -1.32;
  root.add(torso, neck, collar);

  // State, all eased every frame.
  let mood = -0.2, moodTarget = -0.2;
  let talk = 0, talkTarget = 0;
  const look = new THREE.Vector2(), lookTarget = new THREE.Vector2();
  let blinkAt = 2, blink = 0;
  let kick = 0, kickKind: "scoff" | "slam" | "nod" = "nod";

  function resize() {
    const w = canvas.clientWidth, h = canvas.clientHeight;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }
  const ro = new ResizeObserver(resize);
  ro.observe(canvas);
  resize();

  const clock = new THREE.Clock();
  let raf = 0;
  function frame() {
    const dt = Math.min(0.05, clock.getDelta());
    const t = clock.elapsedTime;
    const ease = (cur: number, to: number, rate: number) => cur + (to - cur) * (1 - Math.exp(-rate * dt));
    mood = ease(mood, moodTarget, 4);
    talk = ease(talk, talkTarget, 18);
    look.x = ease(look.x, lookTarget.x, 5);
    look.y = ease(look.y, lookTarget.y, 5);
    kick = Math.max(0, kick - dt * 2.2);

    // Breathing and a slow idle sway.
    root.position.y = Math.sin(t * 1.6) * 0.025;
    const k = kick * kick;
    head.rotation.y = look.x * 0.35 + Math.sin(t * 0.5) * 0.04;
    head.rotation.x = -look.y * 0.18 + talk * 0.05 * Math.sin(t * 9) +
      (kickKind === "scoff" ? -0.25 * k : kickKind === "nod" ? 0.2 * Math.sin(kick * 9) * kick : 0.1 * k);
    head.rotation.z = Math.sin(t * 0.7) * 0.02 + (kickKind === "scoff" ? 0.08 * k : 0);

    // Brows: angrier = lower and slanted in. A slam drops them further.
    const anger = Math.max(0, -mood) + (kickKind === "slam" ? k * 0.8 : 0);
    const joy = Math.max(0, mood);
    for (const b of brows) {
      // Pleased = one brow cocked (his left goes up), not both raised in surprise.
      const cock = b.sx > 0 ? joy : 0;
      b.m.rotation.z = b.sx * (0.42 * (anger + 0.25) * (1 - joy) - 0.15 * cock); // + = inner ends down
      b.m.position.y = 0.42 - 0.06 * anger + 0.1 * cock + talk * 0.03;
    }

    // Blink every few seconds; squint when angry.
    if (t > blinkAt) { blink = 1; blinkAt = t + 2.5 + Math.random() * 3; }
    blink = Math.max(0, blink - dt * 9);
    for (const e of eyes) {
      // 0 = wide open, 1 = shut. Rests half-lidded, narrower when angry, wider when pleased.
      const rest = 0.55 + 0.2 * anger + 0.05 * joy; // smug, not startled
      const shut = Math.max(blink > 0.5 ? 2 - 2 * blink : 2 * blink, rest);
      e.lid.rotation.x = -1.4 + 2.0 * Math.min(1, shut);
      e.iris.position.x = look.x * 0.035;
      e.iris.position.y = look.y * 0.025;
    }

    // Jaw: mouth opens with the voice, the mustache rides up a touch.
    mouth.visible = talk > 0.04;
    mouth.scale.set(0.8 + talk * 0.25, 0.25 + talk * 0.85, 1);
    mouth.position.y = -0.5 - talk * 0.06;
    mustache.position.y = -0.36 + talk * 0.02 + joy * 0.04; // cheeks lift in a grin
    mustache.scale.x = 1 + joy * 0.08;
    mustache.rotation.z = Math.sin(t * 11) * talk * 0.04;

    renderer.render(scene, camera);
    raf = requestAnimationFrame(frame);
  }
  raf = requestAnimationFrame(frame);

  return {
    setMood: (m) => { moodTarget = Math.max(-1, Math.min(1, m)); },
    setTalk: (l) => { talkTarget = Math.max(0, Math.min(1, l)); },
    lookAt: (x, y) => { lookTarget.set(x, y); },
    react: (kind) => { kickKind = kind; kick = 1; },
    dispose: () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      scene.traverse((o) => {
        if (o instanceof THREE.Mesh) {
          o.geometry.dispose();
          (Array.isArray(o.material) ? o.material : [o.material]).forEach((m) => m.dispose());
        }
      });
      renderer.dispose();
    },
  };
}
