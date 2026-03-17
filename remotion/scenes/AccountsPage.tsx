import React from "react";
import { spring, useCurrentFrame, useVideoConfig, interpolate } from "remotion";
import { colors, fontFamily, card } from "../styles";

const balanceItems = [
  { label: "Balance", value: "$12,450.00", color: colors.fg },
  { label: "Equity", value: "$12,680.50", color: colors.fg },
  { label: "Unrealized P&L", value: "+$230.50", color: colors.success },
  { label: "Realized P&L", value: "+$425.30", color: colors.success },
  { label: "Available Margin", value: "$8,200.00", color: colors.fg },
  { label: "Used Margin", value: "$4,250.00", color: colors.fg },
  { label: "Frozen Margin", value: "$0.00", color: colors.fg },
  { label: "Asset (USDT)", value: "$12,450.00", color: colors.fg },
];

export const AccountsPage: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  return (
    <div style={{ fontFamily }}>
      <h1 style={{ fontSize: 24, fontWeight: 700, color: colors.fg, marginBottom: 24 }}>Accounts</h1>

      <div style={{ ...card, padding: 16 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
          <span style={{ fontSize: 18, fontWeight: 600, color: colors.fg }}>Balance</span>
          <div
            style={{
              padding: "6px 14px",
              borderRadius: 8,
              border: `1px solid ${colors.border}`,
              fontSize: 13,
              color: colors.fg,
            }}
          >
            Refresh
          </div>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 12 }}>
          {balanceItems.map((item, i) => {
            const s = spring({ fps, frame: frame - i * 4, config: { damping: 15 } });
            const y = interpolate(s, [0, 1], [15, 0]);
            const opacity = interpolate(s, [0, 1], [0, 1]);

            return (
              <div
                key={item.label}
                style={{
                  ...card,
                  padding: 16,
                  opacity,
                  transform: `translateY(${y}px)`,
                }}
              >
                <div style={{ fontSize: 12, color: colors.muted, marginBottom: 4 }}>{item.label}</div>
                <div style={{ fontSize: 18, fontWeight: 700, color: item.color }}>{item.value}</div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
};
