import React from "react";
import { AbsoluteFill, interpolate, useCurrentFrame, spring, useVideoConfig } from "remotion";
import { colors, fontFamily } from "../styles";

export const Outro: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const fadeIn = interpolate(frame, [0, 20], [0, 1], { extrapolateRight: "clamp" });
  const titleY = interpolate(
    spring({ fps, frame, config: { damping: 15, mass: 0.8 } }),
    [0, 1],
    [20, 0]
  );

  const lineScale = spring({ fps, frame: frame - 12, config: { damping: 15 } });

  return (
    <AbsoluteFill
      style={{
        background: colors.bg,
        justifyContent: "center",
        alignItems: "center",
        fontFamily,
        opacity: fadeIn,
      }}
    >
      <div
        style={{
          fontSize: 44,
          fontWeight: 800,
          color: colors.fg,
          letterSpacing: -1,
          transform: `translateY(${titleY}px)`,
        }}
      >
        BingX Bot
      </div>
      <div style={{ fontSize: 18, color: colors.accent, marginTop: 10 }}>
        Trade Smarter — Automated Grid Trading
      </div>
      <div
        style={{
          width: 60,
          height: 3,
          background: colors.accent,
          borderRadius: 2,
          marginTop: 18,
          transform: `scaleX(${lineScale})`,
        }}
      />
    </AbsoluteFill>
  );
};
