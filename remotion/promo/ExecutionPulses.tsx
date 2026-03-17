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
