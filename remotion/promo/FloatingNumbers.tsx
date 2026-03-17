import React from "react";
import { AbsoluteFill, useCurrentFrame, interpolate } from "remotion";
import { FLOATING_NUMBERS } from "./data";

const HEIGHT = 720;
const OFFSET_X = (1280 - 1024) / 2;
const LIFETIME = 90;
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
