import React from "react";
import { AbsoluteFill, useCurrentFrame, interpolate } from "remotion";
import { GRID_Y_POSITIONS } from "./data";

const WIDTH = 1280;
const HEIGHT = 720;
const LINE_WIDTH = 1024;
const OFFSET_X = (WIDTH - LINE_WIDTH) / 2;

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

        // Dissolution fade-out: frames 1200–1500
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
