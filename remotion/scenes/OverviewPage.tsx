import React from "react";
import { interpolate, useCurrentFrame, spring, useVideoConfig } from "remotion";
import { colors, fontFamily, card } from "../styles";

const stats = [
  { label: "Balance", value: 12450.0, prefix: "$", color: colors.fg },
  { label: "Equity", value: 12680.5, prefix: "$", color: colors.fg },
  { label: "Unrealized P&L", value: 230.5, prefix: "+$", color: colors.success },
  { label: "Available", value: 8200.0, prefix: "$", color: colors.fg },
];

const bots = [
  { symbol: "BTCUSDT", grids: 10 },
  { symbol: "ETHUSDT", grids: 8 },
  { symbol: "SOLUSDT", grids: 5 },
];

function CountUp({ value, prefix, frame, delay, color }: {
  value: number; prefix: string; frame: number; delay: number; color: string;
}) {
  const progress = interpolate(frame - delay, [0, 30], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const current = value * progress;
  const showSkeleton = frame < delay;

  return (
    <div style={{ fontSize: 18, fontWeight: 700, color, fontVariantNumeric: "tabular-nums" }}>
      {showSkeleton ? (
        <div
          style={{
            height: 22,
            width: 100,
            background: `linear-gradient(90deg, ${colors.default200} 30%, #333 50%, ${colors.default200} 70%)`,
            borderRadius: 6,
          }}
        />
      ) : (
        `${prefix}${current.toFixed(2)}`
      )}
    </div>
  );
}

export const OverviewPage: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const titleOpacity = interpolate(frame, [0, 12], [0, 1], { extrapolateRight: "clamp" });

  // Bots summary appears later
  const botsSummaryFrame = frame - 80;
  const botsSummarySpring = spring({ fps, frame: Math.max(0, botsSummaryFrame), config: { damping: 15 } });
  const botsSummaryY = interpolate(botsSummarySpring, [0, 1], [15, 0]);
  const botsSummaryOpacity = interpolate(botsSummaryFrame, [0, 15], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  return (
    <div style={{ fontFamily }}>
      {/* Title */}
      <h1
        style={{
          fontSize: 24,
          fontWeight: 700,
          color: colors.fg,
          marginBottom: 24,
          opacity: titleOpacity,
        }}
      >
        Overview
      </h1>

      {/* Stats Grid */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 12, marginBottom: 24 }}>
        {stats.map((stat, i) => {
          const cardSpring = spring({ fps, frame: frame - 10 - i * 5, config: { damping: 15 } });
          const cardY = interpolate(cardSpring, [0, 1], [15, 0]);
          const cardOpacity = interpolate(cardSpring, [0, 1], [0, 1]);

          return (
            <div
              key={stat.label}
              style={{
                ...card,
                padding: 16,
                opacity: cardOpacity,
                transform: `translateY(${cardY}px)`,
              }}
            >
              <div style={{ fontSize: 12, color: colors.muted, marginBottom: 4 }}>
                {stat.label}
              </div>
              <CountUp
                value={stat.value}
                prefix={stat.prefix}
                frame={frame}
                delay={30 + i * 5}
                color={stat.color}
              />
            </div>
          );
        })}
      </div>

      {/* Bots Summary */}
      <div
        style={{
          ...card,
          padding: 16,
          opacity: botsSummaryOpacity,
          transform: `translateY(${botsSummaryY}px)`,
        }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
          <span style={{ fontSize: 14, fontWeight: 600, color: colors.fg }}>Bots</span>
          <span style={{ fontSize: 12, color: colors.accent }}>View all &rarr;</span>
        </div>
        <div style={{ display: "flex", gap: 16, fontSize: 14, marginBottom: 12 }}>
          <div>
            <span style={{ fontWeight: 500, color: colors.success }}>3</span>{" "}
            <span style={{ color: colors.muted }}>Running</span>
          </div>
          <div>
            <span style={{ fontWeight: 500, color: colors.muted }}>1</span>{" "}
            <span style={{ color: colors.muted }}>Stopped</span>
          </div>
        </div>
        {bots.map((bot) => (
          <div
            key={bot.symbol}
            style={{
              display: "flex",
              justifyContent: "space-between",
              padding: "6px 0",
              fontSize: 14,
            }}
          >
            <span style={{ fontWeight: 500, color: colors.fg }}>{bot.symbol}</span>
            <span style={{ fontSize: 12, color: colors.muted }}>{bot.grids} grids</span>
          </div>
        ))}
      </div>
    </div>
  );
};
