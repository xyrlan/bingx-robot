# Login Promo Video Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a ~50s Remotion motion graphics video with 6 animated layers (particles, grid lines, price line, candlesticks, execution pulses, floating numbers) that plays in loop on the login page.

**Architecture:** Pre-computed data in `data.ts` drives all 6 layers. Each layer is a standalone React component using `useCurrentFrame()` + `interpolate()`. The main composition stacks them with `AbsoluteFill`. Video renders to MP4 and replaces the current dashboard demo on the login page.

**Tech Stack:** Remotion (already installed), React, TypeScript

**Spec:** `docs/superpowers/specs/2026-03-16-login-promo-video-design.md`

---

## File Structure

| File | Responsibility |
|------|---------------|
| `remotion/promo/data.ts` | All pre-computed data: particles, grid positions, price path, candles, pulses, floating numbers. Seeded PRNG. |
| `remotion/promo/Particles.tsx` | Layer 1: 40 floating dots + SVG connection lines. Wrapping position via `frame % 1500`. |
| `remotion/promo/GridLines.tsx` | Layer 2: 8 horizontal cyan lines with staggered fade-in and dissolution fade-out. |
| `remotion/promo/PriceLine.tsx` | Layer 3: Rotated div segments between waypoints, revealed progressively left-to-right. |
| `remotion/promo/Candlesticks.tsx` | Layer 4: Styled candle bodies + wicks with spring scale-in. |
| `remotion/promo/ExecutionPulses.tsx` | Layer 5: Expanding circles at grid crossings. |
| `remotion/promo/FloatingNumbers.tsx` | Layer 6: Monospace numbers with fade-in/out and upward drift. |
| `remotion/LoginPromoVideo.tsx` | Main composition: stacks all 6 layers with AbsoluteFill. |
| `remotion/Root.tsx` | Modify: register LoginPromoVideo composition. |
| `src/app/(auth)/login/page.tsx` | Modify: change video src from `dashboard-demo.mp4` to `login-promo.mp4`. |
| `package.json` | Modify: add `render:promo` script. |

---

## Chunk 1: Data Layer + Particles + Grid Lines

### Task 1: Create pre-computed data (`data.ts`)

**Files:**
- Create: `remotion/promo/data.ts`

- [ ] **Step 1: Create data.ts with seeded PRNG and all data arrays**

```ts
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
```

- [ ] **Step 2: Verify TypeScript compiles**

Run: `npx tsc --noEmit remotion/promo/data.ts 2>&1 || echo "checking..."`

If tsc isn't configured for standalone files, just verify no red squiggles in the editor. The Remotion bundler will catch errors at render time.

- [ ] **Step 3: Commit**

```bash
git add remotion/promo/data.ts
git commit -m "feat(promo): add pre-computed data for login promo video"
```

---

### Task 2: Create Particles component (Layer 1)

**Files:**
- Create: `remotion/promo/Particles.tsx`

- [ ] **Step 1: Create Particles.tsx**

```tsx
// remotion/promo/Particles.tsx
import React from "react";
import { AbsoluteFill, useCurrentFrame, interpolate } from "remotion";
import { PARTICLES, PULSES } from "./data";

const WIDTH = 1280;
const HEIGHT = 720;
const TOTAL_FRAMES = 1500;
const CONNECTION_DIST = 100;
const OFFSET_X = (WIDTH - 1024) / 2; // 128px

function wrap(val: number, max: number): number {
  return ((val % max) + max) % max;
}

export const Particles: React.FC = () => {
  const frame = useCurrentFrame();
  const loopFrame = frame % TOTAL_FRAMES;

  // Calculate current positions
  const positions = PARTICLES.map((p) => ({
    x: wrap(p.x + p.vx * loopFrame, WIDTH),
    y: wrap(p.y + p.vy * loopFrame, HEIGHT),
    size: p.size,
    isCyan: p.isCyan,
  }));

  // Check which pulses are active (within ±15 frames)
  const activePulsePositions = PULSES.filter(
    (pulse) => Math.abs(frame - pulse.frame) <= 15
  ).map((p) => ({ x: OFFSET_X + p.x, y: (p.y / 100) * HEIGHT }));

  // Build connection lines
  const lines: Array<{
    x1: number; y1: number; x2: number; y2: number; opacity: number;
  }> = [];
  for (let i = 0; i < positions.length; i++) {
    for (let j = i + 1; j < positions.length; j++) {
      const dx = positions[i].x - positions[j].x;
      const dy = positions[i].y - positions[j].y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist < CONNECTION_DIST) {
        lines.push({
          x1: positions[i].x,
          y1: positions[i].y,
          x2: positions[j].x,
          y2: positions[j].y,
          opacity: (1 - dist / CONNECTION_DIST) * 0.15,
        });
      }
    }
  }

  // Fade-in during first 60 frames
  const globalOpacity = interpolate(frame, [0, 60], [0, 1], {
    extrapolateRight: "clamp",
  });

  return (
    <AbsoluteFill style={{ opacity: globalOpacity }}>
      {/* SVG connection lines */}
      <svg
        width={WIDTH}
        height={HEIGHT}
        style={{ position: "absolute", top: 0, left: 0 }}
      >
        {lines.map((line, i) => (
          <line
            key={i}
            x1={line.x1}
            y1={line.y1}
            x2={line.x2}
            y2={line.y2}
            stroke="#06b6d4"
            strokeWidth={0.5}
            opacity={line.opacity}
          />
        ))}
      </svg>

      {/* Particle dots */}
      {positions.map((p, i) => {
        // Brighten near active pulses
        const nearPulse = activePulsePositions.some((pulse) => {
          const dx = p.x - pulse.x;
          const dy = p.y - pulse.y;
          return Math.sqrt(dx * dx + dy * dy) < 120;
        });
        const baseOpacity = PARTICLES[i].isCyan ? 0.5 : 0.2;
        const opacity = nearPulse ? baseOpacity + 0.2 : baseOpacity;

        return (
          <div
            key={i}
            style={{
              position: "absolute",
              left: p.x - p.size / 2,
              top: p.y - p.size / 2,
              width: p.size,
              height: p.size,
              borderRadius: "50%",
              background: p.isCyan ? "#06b6d4" : "#27272a",
              opacity,
            }}
          />
        );
      })}
    </AbsoluteFill>
  );
};
```

- [ ] **Step 2: Commit**

```bash
git add remotion/promo/Particles.tsx
git commit -m "feat(promo): add Particles layer (floating dots + SVG connections)"
```

---

### Task 3: Create GridLines component (Layer 2)

**Files:**
- Create: `remotion/promo/GridLines.tsx`

- [ ] **Step 1: Create GridLines.tsx**

```tsx
// remotion/promo/GridLines.tsx
import React from "react";
import { AbsoluteFill, useCurrentFrame, interpolate } from "remotion";
import { GRID_Y_POSITIONS } from "./data";

const WIDTH = 1280;
const HEIGHT = 720;
const LINE_WIDTH = 1024;
const OFFSET_X = (WIDTH - LINE_WIDTH) / 2; // 128px

export const GridLines: React.FC = () => {
  const frame = useCurrentFrame();

  return (
    <AbsoluteFill>
      {GRID_Y_POSITIONS.map((yPercent, i) => {
        const y = (yPercent / 100) * HEIGHT;

        // Staggered fade-in: each line 15 frames apart, starting at frame 0
        const fadeIn = interpolate(frame, [i * 15, i * 15 + 30], [0, 1], {
          extrapolateLeft: "clamp",
          extrapolateRight: "clamp",
        });

        // Dissolution fade-out: frames 1200–1400
        const fadeOut = interpolate(frame, [1200, 1500], [1, 0], {
          extrapolateLeft: "clamp",
          extrapolateRight: "clamp",
        });

        const opacity = fadeIn * fadeOut * 0.15;

        return (
          <div
            key={i}
            style={{
              position: "absolute",
              left: OFFSET_X,
              top: y,
              width: LINE_WIDTH,
              height: 1,
              background: "#06b6d4",
              opacity,
              boxShadow: `0 0 12px rgba(6, 182, 212, ${opacity * 2})`,
            }}
          />
        );
      })}
    </AbsoluteFill>
  );
};
```

- [ ] **Step 2: Commit**

```bash
git add remotion/promo/GridLines.tsx
git commit -m "feat(promo): add GridLines layer (8 horizontal cyan lines)"
```

---

## Chunk 2: Price Line + Candlesticks + Execution Pulses + Floating Numbers

### Task 4: Create PriceLine component (Layer 3)

**Files:**
- Create: `remotion/promo/PriceLine.tsx`

- [ ] **Step 1: Create PriceLine.tsx**

```tsx
// remotion/promo/PriceLine.tsx
import React from "react";
import { AbsoluteFill, useCurrentFrame, interpolate } from "remotion";
import { PRICE_PATH } from "./data";

const WIDTH = 1280;
const HEIGHT = 720;
const OFFSET_X = (WIDTH - 1024) / 2; // 128px
const DRAW_START = 150;
const DRAW_END = 1200;
const TOTAL_X = 1024; // total horizontal pixels

export const PriceLine: React.FC = () => {
  const frame = useCurrentFrame();

  // How far the line has been drawn (in x pixels)
  const drawProgress = interpolate(
    frame,
    [DRAW_START, DRAW_END],
    [0, TOTAL_X],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp" }
  );

  // Dissolution fade-out
  const fadeOut = interpolate(frame, [1200, 1500], [1, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  // Build segments between consecutive waypoints
  const segments: Array<{
    x1: number; y1: number; x2: number; y2: number;
  }> = [];

  for (let i = 0; i < PRICE_PATH.length - 1; i++) {
    const p1 = PRICE_PATH[i];
    const p2 = PRICE_PATH[i + 1];

    // Skip segments not yet drawn
    if (p1.x > drawProgress) break;

    // Clip the end of the last visible segment
    const clippedX2 = Math.min(p2.x, drawProgress);
    const t = p2.x === p1.x ? 1 : (clippedX2 - p1.x) / (p2.x - p1.x);
    const clippedY2 = p1.y + t * (p2.y - p1.y);

    segments.push({
      x1: p1.x,
      y1: (p1.y / 100) * HEIGHT,
      x2: clippedX2,
      y2: (clippedY2 / 100) * HEIGHT,
    });
  }

  return (
    <AbsoluteFill style={{ opacity: fadeOut }}>
      {segments.map((seg, i) => {
        const dx = seg.x2 - seg.x1;
        const dy = seg.y2 - seg.y1;
        const length = Math.sqrt(dx * dx + dy * dy);
        const angle = Math.atan2(dy, dx) * (180 / Math.PI);

        if (length < 0.5) return null;

        return (
          <div
            key={i}
            style={{
              position: "absolute",
              left: OFFSET_X + seg.x1,
              top: seg.y1,
              width: length,
              height: 2,
              background: "#fafafa",
              opacity: 0.6,
              transformOrigin: "0 0",
              transform: `rotate(${angle}deg)`,
              borderRadius: 1,
            }}
          />
        );
      })}
    </AbsoluteFill>
  );
};
```

- [ ] **Step 2: Commit**

```bash
git add remotion/promo/PriceLine.tsx
git commit -m "feat(promo): add PriceLine layer (progressive line drawing)"
```

---

### Task 5: Create Candlesticks component (Layer 4)

**Files:**
- Create: `remotion/promo/Candlesticks.tsx`

- [ ] **Step 1: Create Candlesticks.tsx**

```tsx
// remotion/promo/Candlesticks.tsx
import React from "react";
import { AbsoluteFill, useCurrentFrame, interpolate, spring, useVideoConfig } from "remotion";
import { CANDLES } from "./data";

const WIDTH = 1280;
const HEIGHT = 720;
const OFFSET_X = (WIDTH - 1024) / 2;
const CANDLE_WIDTH = 10;
const WICK_EXTEND = 8;

export const Candlesticks: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  // Dissolution fade-out
  const fadeOut = interpolate(frame, [1200, 1500], [1, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  return (
    <AbsoluteFill style={{ opacity: fadeOut }}>
      {CANDLES.map((candle, i) => {
        // Don't render before appearance frame
        if (frame < candle.frame) return null;

        const localFrame = frame - candle.frame;
        const scaleY = spring({
          fps,
          frame: localFrame,
          config: { damping: 15, mass: 0.6 },
        });

        const x = OFFSET_X + candle.x - CANDLE_WIDTH / 2;
        const yCenter = (candle.y / 100) * HEIGHT;
        const bodyTop = yCenter - (candle.height / 2) * scaleY;
        const color = candle.isGreen ? "#22c55e" : "#ef4444";
        const opacity = 0.4 + (candle.isGreen ? 0.3 : 0.1);

        return (
          <div key={i} style={{ position: "absolute", left: x, top: 0, width: CANDLE_WIDTH, height: HEIGHT, opacity }}>
            {/* Wick */}
            <div
              style={{
                position: "absolute",
                left: CANDLE_WIDTH / 2 - 1,
                top: bodyTop - WICK_EXTEND * scaleY,
                width: 2,
                height: (candle.height + WICK_EXTEND * 2) * scaleY,
                background: color,
                opacity: 0.5,
              }}
            />
            {/* Body */}
            <div
              style={{
                position: "absolute",
                left: 0,
                top: bodyTop,
                width: CANDLE_WIDTH,
                height: candle.height * scaleY,
                background: color,
                borderRadius: 2,
              }}
            />
          </div>
        );
      })}
    </AbsoluteFill>
  );
};
```

- [ ] **Step 2: Commit**

```bash
git add remotion/promo/Candlesticks.tsx
git commit -m "feat(promo): add Candlesticks layer (spring-animated candles)"
```

---

### Task 6: Create ExecutionPulses component (Layer 5)

**Files:**
- Create: `remotion/promo/ExecutionPulses.tsx`

- [ ] **Step 1: Create ExecutionPulses.tsx**

```tsx
// remotion/promo/ExecutionPulses.tsx
import React from "react";
import { AbsoluteFill, useCurrentFrame, interpolate } from "remotion";
import { PULSES } from "./data";

const WIDTH = 1280;
const HEIGHT = 720;
const OFFSET_X = (WIDTH - 1024) / 2;
const PULSE_DURATION = 30;
const MAX_RADIUS = 40;

export const ExecutionPulses: React.FC = () => {
  const frame = useCurrentFrame();

  return (
    <AbsoluteFill>
      {PULSES.map((pulse, i) => {
        const localFrame = frame - pulse.frame;
        if (localFrame < 0 || localFrame > PULSE_DURATION) return null;

        const progress = localFrame / PULSE_DURATION;
        const scale = interpolate(progress, [0, 1], [0, 1]);
        const opacity = interpolate(progress, [0, 0.3, 1], [0, 0.6, 0], {
          extrapolateRight: "clamp",
        });

        const x = OFFSET_X + pulse.x;
        const y = (pulse.y / 100) * HEIGHT;
        const size = MAX_RADIUS * 2 * scale;

        return (
          <div
            key={i}
            style={{
              position: "absolute",
              left: x - size / 2,
              top: y - size / 2,
              width: size,
              height: size,
              borderRadius: "50%",
              border: `2px solid ${pulse.color}`,
              opacity,
              boxShadow: `0 0 20px ${pulse.color}`,
            }}
          />
        );
      })}
    </AbsoluteFill>
  );
};
```

- [ ] **Step 2: Commit**

```bash
git add remotion/promo/ExecutionPulses.tsx
git commit -m "feat(promo): add ExecutionPulses layer (expanding circles)"
```

---

### Task 7: Create FloatingNumbers component (Layer 6)

**Files:**
- Create: `remotion/promo/FloatingNumbers.tsx`

- [ ] **Step 1: Create FloatingNumbers.tsx**

```tsx
// remotion/promo/FloatingNumbers.tsx
import React from "react";
import { AbsoluteFill, useCurrentFrame, interpolate } from "remotion";
import { FLOATING_NUMBERS } from "./data";

const WIDTH = 1280;
const HEIGHT = 720;
const OFFSET_X = (WIDTH - 1024) / 2;
const LIFETIME = 90; // total frames visible
const FADE_IN = 15;
const FADE_OUT = 15;
const DRIFT_Y = -20;

export const FloatingNumbers: React.FC = () => {
  const frame = useCurrentFrame();

  return (
    <AbsoluteFill>
      {FLOATING_NUMBERS.map((num, i) => {
        const localFrame = frame - num.frame;
        if (localFrame < 0 || localFrame > LIFETIME) return null;

        const opacity = interpolate(
          localFrame,
          [0, FADE_IN, LIFETIME - FADE_OUT, LIFETIME],
          [0, 0.4, 0.4, 0],
          { extrapolateRight: "clamp" }
        );

        const y = (num.y / 100) * HEIGHT + interpolate(
          localFrame,
          [0, LIFETIME],
          [0, DRIFT_Y],
          { extrapolateRight: "clamp" }
        );

        return (
          <div
            key={i}
            style={{
              position: "absolute",
              left: OFFSET_X + num.x,
              top: y,
              fontFamily: "'Courier New', monospace",
              fontSize: 13,
              color: "#a1a1aa",
              opacity,
              whiteSpace: "nowrap",
            }}
          >
            {num.text}
          </div>
        );
      })}
    </AbsoluteFill>
  );
};
```

- [ ] **Step 2: Commit**

```bash
git add remotion/promo/FloatingNumbers.tsx
git commit -m "feat(promo): add FloatingNumbers layer (drifting price labels)"
```

---

## Chunk 3: Main Composition + Registration + Render + Integration

### Task 8: Create LoginPromoVideo composition

**Files:**
- Create: `remotion/LoginPromoVideo.tsx`

- [ ] **Step 1: Create LoginPromoVideo.tsx**

```tsx
// remotion/LoginPromoVideo.tsx
import React from "react";
import { AbsoluteFill } from "remotion";
import { colors } from "./styles";
import { Particles } from "./promo/Particles";
import { GridLines } from "./promo/GridLines";
import { PriceLine } from "./promo/PriceLine";
import { Candlesticks } from "./promo/Candlesticks";
import { ExecutionPulses } from "./promo/ExecutionPulses";
import { FloatingNumbers } from "./promo/FloatingNumbers";

export const LoginPromoVideo: React.FC = () => {
  return (
    <AbsoluteFill style={{ background: colors.bg }}>
      <Particles />
      <GridLines />
      <PriceLine />
      <Candlesticks />
      <ExecutionPulses />
      <FloatingNumbers />
    </AbsoluteFill>
  );
};
```

- [ ] **Step 2: Commit**

```bash
git add remotion/LoginPromoVideo.tsx
git commit -m "feat(promo): add LoginPromoVideo composition (6 layers)"
```

---

### Task 9: Register composition in Root.tsx

**Files:**
- Modify: `remotion/Root.tsx`

- [ ] **Step 1: Add LoginPromoVideo to Root.tsx**

Add a second `<Composition>` inside a fragment:

```tsx
// remotion/Root.tsx
import React from "react";
import { Composition } from "remotion";
import { DashboardDemo } from "./DashboardDemo";
import { LoginPromoVideo } from "./LoginPromoVideo";

export const RemotionRoot: React.FC = () => {
  return (
    <>
      <Composition
        id="DashboardDemo"
        component={DashboardDemo}
        durationInFrames={900}
        fps={30}
        width={1280}
        height={720}
      />
      <Composition
        id="LoginPromoVideo"
        component={LoginPromoVideo}
        durationInFrames={1500}
        fps={30}
        width={1280}
        height={720}
      />
    </>
  );
};
```

- [ ] **Step 2: Add render:promo script to package.json**

Add to the `"scripts"` section:

```json
"render:promo": "remotion render remotion/index.ts LoginPromoVideo public/login-promo.mp4"
```

- [ ] **Step 3: Verify composition is registered**

Run: `npx remotion compositions remotion/index.ts`

Expected output should include:
```
LoginPromoVideo    30      1280x720       1500 (50.00 sec)
```

- [ ] **Step 4: Commit**

```bash
git add remotion/Root.tsx package.json
git commit -m "feat(promo): register LoginPromoVideo composition + render script"
```

---

### Task 10: Render video and preview in Remotion Studio

- [ ] **Step 1: Preview in Remotion Studio**

Run: `npx remotion studio remotion/index.ts`

Open the URL in browser. Select "LoginPromoVideo" composition. Scrub through the timeline to verify:
- Particles appear and float (frames 0–60 fade-in)
- Grid lines appear one by one (frames 0–150)
- Price line draws left to right (frames 150–1200)
- Candlesticks pop up with spring animation (frames 300+)
- Pulses flash at grid crossings (frames 450–1050)
- Floating numbers drift up and fade (frames 300–1200)
- Everything dissolves except particles (frames 1200–1500)
- Frame 0 and 1499 look similar (seamless loop)

Fix any visual issues before rendering.

- [ ] **Step 2: Render the video**

Run: `npx remotion render remotion/index.ts LoginPromoVideo public/login-promo.mp4`

Expected: MP4 file created at `public/login-promo.mp4`, approximately 3-6 MB.

- [ ] **Step 3: Commit**

```bash
git add public/login-promo.mp4
git commit -m "feat(promo): render login promo video (50s motion graphics)"
```

---

### Task 11: Integrate video in login page

**Files:**
- Modify: `src/app/(auth)/login/page.tsx:104`

- [ ] **Step 1: Update video src**

Change the `<video>` `src` attribute from `/dashboard-demo.mp4` to `/login-promo.mp4`:

```tsx
// In src/app/(auth)/login/page.tsx, line 104
// Change:
src="/dashboard-demo.mp4"
// To:
src="/login-promo.mp4"
```

- [ ] **Step 2: Remove old video file**

Run: `rm public/dashboard-demo.mp4`

- [ ] **Step 3: Verify locally**

Run: `npm run dev`

Open `http://localhost:3000/login` in browser. Verify:
- Video plays automatically on the right side of the login card
- Video loops seamlessly
- Video is hidden on mobile (resize browser to < 1024px)

- [ ] **Step 4: Commit**

```bash
git add src/app/(auth)/login/page.tsx
git rm public/dashboard-demo.mp4
git commit -m "feat: replace dashboard demo with motion graphics promo on login page"
```
