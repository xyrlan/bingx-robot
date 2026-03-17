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
