import React from "react";
import { AbsoluteFill, interpolate, useCurrentFrame, spring, useVideoConfig } from "remotion";
import { colors, fontFamily } from "../styles";

export const Splash: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const titleY = interpolate(frame, [0, 20], [30, 0], { extrapolateRight: "clamp" });
  const titleOpacity = interpolate(frame, [0, 20], [0, 1], { extrapolateRight: "clamp" });

  const subtitleOpacity = interpolate(frame, [12, 28], [0, 1], { extrapolateRight: "clamp" });

  const lineScale = spring({ fps, frame: frame - 18, config: { damping: 15 } });
  const lineOpacity = interpolate(frame, [18, 28], [0, 1], { extrapolateRight: "clamp" });

  // Fade out at the end
  const fadeOut = interpolate(frame, [65, 80], [1, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  return (
    <AbsoluteFill
      style={{
        background: colors.bg,
        justifyContent: "center",
        alignItems: "center",
        fontFamily,
        opacity: fadeOut,
      }}
    >
      <div
        style={{
          fontSize: 56,
          fontWeight: 800,
          color: colors.fg,
          letterSpacing: -1.5,
          transform: `translateY(${titleY}px)`,
          opacity: titleOpacity,
        }}
      >
        BingX Bot
      </div>
      <div
        style={{
          fontSize: 20,
          color: colors.muted,
          marginTop: 12,
          opacity: subtitleOpacity,
        }}
      >
        Automated Grid Trading
      </div>
      <div
        style={{
          width: 60,
          height: 3,
          background: colors.accent,
          borderRadius: 2,
          marginTop: 20,
          opacity: lineOpacity,
          transform: `scaleX(${lineScale})`,
        }}
      />
    </AbsoluteFill>
  );
};
