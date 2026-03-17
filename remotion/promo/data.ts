// remotion/promo/data.ts

// ── Seeded PRNG (deterministic) ──
function seededRandom(seed: number) {
  let s = seed;
  return () => {
    s = (s * 16807 + 0) % 2147483647;
    return (s - 1) / 2147483646;
  };
}

export const PARTICLE_SEED = 42;
const rand = seededRandom(PARTICLE_SEED);

// ── Grid Y positions (% of 720px height) ──
export const GRID_Y_POSITIONS = [15, 25, 35, 45, 55, 65, 75, 85];

// ── Price path waypoints ──
// x: pixel position (0–1024), y: percentage of height (oscillates between grid levels)
export const PRICE_PATH: Array<{ x: number; y: number }> = [
  { x: 0, y: 50 },
  { x: 50, y: 45 },
  { x: 100, y: 35 },
  { x: 160, y: 38 },
  { x: 220, y: 25 },
  { x: 280, y: 30 },
  { x: 340, y: 35 },
  { x: 400, y: 25 },
  { x: 460, y: 30 },
  { x: 520, y: 45 },
  { x: 580, y: 55 },
  { x: 640, y: 45 },
  { x: 700, y: 35 },
  { x: 760, y: 25 },
  { x: 820, y: 15 },
  { x: 870, y: 25 },
  { x: 920, y: 35 },
  { x: 960, y: 45 },
  { x: 1000, y: 55 },
  { x: 1024, y: 50 },
];

// ── Candles ──
export const CANDLES: Array<{
  frame: number;
  x: number;
  y: number;
  height: number;
  isGreen: boolean;
}> = Array.from({ length: 20 }, (_, i) => {
  const pathIdx = Math.floor((i / 20) * (PRICE_PATH.length - 1));
  const p = PRICE_PATH[pathIdx];
  return {
    frame: 300 + Math.floor((i / 20) * 800),
    x: p.x,
    y: p.y,
    height: 20 + Math.floor(rand() * 40),
    isGreen: rand() < 0.7,
  };
});

// ── Pulses (at grid crossings) ──
export const PULSES: Array<{
  frame: number;
  x: number;
  y: number;
  color: string;
}> = (() => {
  const result: Array<{ frame: number; x: number; y: number; color: string }> = [];
  for (let i = 1; i < PRICE_PATH.length; i++) {
    const prev = PRICE_PATH[i - 1];
    const curr = PRICE_PATH[i];
    for (const gridY of GRID_Y_POSITIONS) {
      if (
        (prev.y <= gridY && curr.y >= gridY) ||
        (prev.y >= gridY && curr.y <= gridY)
      ) {
        const t = (gridY - prev.y) / (curr.y - prev.y);
        const crossX = prev.x + t * (curr.x - prev.x);
        const progress = crossX / 1024;
        const frame = 150 + Math.floor(progress * 1050);
        if (frame >= 450 && frame <= 1050) {
          result.push({
            frame,
            x: crossX,
            y: gridY,
            color: result.length % 2 === 0 ? "#06b6d4" : "#22c55e",
          });
        }
      }
    }
  }
  return result.slice(0, 7);
})();

// ── Floating numbers ──
export const FLOATING_NUMBERS: Array<{
  frame: number;
  x: number;
  y: number;
  text: string;
}> = (() => {
  const texts = [
    "84,200.00", "85,400.00", "83,444.44", "+$145.20",
    "+$46.80", "+0.8%", "86,555.55", "$12,450",
    "+$312.40", "+$89.60",
  ];
  return texts.map((text, i) => {
    const pulse = PULSES[i % PULSES.length];
    return {
      frame: 300 + Math.floor((i / texts.length) * 900),
      x: pulse ? pulse.x + 30 : 200 + i * 80,
      y: pulse ? pulse.y - 5 : 30 + rand() * 50,
      text,
    };
  });
})();

// ── Particles ──
export const PARTICLES: Array<{
  x: number;
  y: number;
  vx: number;
  vy: number;
  size: number;
  isCyan: boolean;
}> = Array.from({ length: 40 }, () => ({
  x: rand() * 1280,
  y: rand() * 720,
  vx: (rand() - 0.5) * 0.6,
  vy: (rand() - 0.5) * 0.6,
  size: 2 + rand() * 2,
  isCyan: rand() < 0.2,
}));
