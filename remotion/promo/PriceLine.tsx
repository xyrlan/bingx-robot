import React from "react";
import { AbsoluteFill, useCurrentFrame, interpolate } from "remotion";
import { PRICE_PATH } from "./data";

const WIDTH = 1280;
const HEIGHT = 720;
const OFFSET_X = (WIDTH - 1024) / 2;
const DRAW_START = 150;
const DRAW_END = 1200;
const TOTAL_X = 1024;

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

    if (p1.x > drawProgress) break;

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
