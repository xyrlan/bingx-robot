import React from "react";
import { AbsoluteFill, useCurrentFrame, interpolate } from "remotion";
import { PARTICLES, PULSES } from "./data";

const WIDTH = 1280;
const HEIGHT = 720;
const TOTAL_FRAMES = 1500;
const CONNECTION_DIST = 100;
const OFFSET_X = (WIDTH - 1024) / 2;

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
