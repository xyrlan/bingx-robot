import React from "react";
import { interpolate, useCurrentFrame, spring, useVideoConfig } from "remotion";
import { colors, fontFamily } from "../styles";

const navItems = [
  { label: "Overview", active: true },
  { label: "Bots", active: false },
  { label: "Accounts", active: false },
  { label: "Settings", active: false },
];

export const Sidebar: React.FC<{ activePage?: string }> = ({ activePage = "Overview" }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const slideX = interpolate(
    spring({ fps, frame, config: { damping: 15, mass: 0.8 } }),
    [0, 1],
    [-256, 0]
  );

  return (
    <div
      style={{
        position: "absolute",
        left: 0,
        top: 0,
        bottom: 0,
        width: 256,
        borderRight: `1px solid ${colors.border}`,
        background: colors.bg,
        fontFamily,
        transform: `translateX(${slideX}px)`,
        display: "flex",
        flexDirection: "column",
        zIndex: 10,
      }}
    >
      {/* Logo */}
      <div
        style={{
          height: 64,
          display: "flex",
          alignItems: "center",
          padding: "0 24px",
          borderBottom: `1px solid ${colors.border}`,
          fontSize: 18,
          fontWeight: 700,
          color: colors.fg,
        }}
      >
        BingX Bot
      </div>

      {/* Account Switcher */}
      <div style={{ padding: 12, borderBottom: `1px solid ${colors.border}` }}>
        <div
          style={{
            padding: "8px 12px",
            borderRadius: 8,
            background: colors.default100,
            border: `1px solid ${colors.border}`,
            color: colors.fg,
            fontSize: 14,
          }}
        >
          Main Account
        </div>
      </div>

      {/* Nav */}
      <div style={{ flex: 1, padding: "16px 12px", display: "flex", flexDirection: "column", gap: 2 }}>
        {navItems.map((item, i) => {
          const isActive = item.label === activePage;
          const itemSpring = spring({ fps, frame: frame - 5 - i * 4, config: { damping: 15 } });
          const itemOpacity = interpolate(itemSpring, [0, 1], [0, 1]);

          return (
            <div
              key={item.label}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 12,
                padding: "10px 12px",
                borderRadius: 8,
                fontSize: 14,
                fontWeight: 500,
                color: isActive ? colors.accent : colors.muted,
                background: isActive ? "rgba(6,182,212,0.1)" : "transparent",
                opacity: itemOpacity,
              }}
            >
              {item.label}
            </div>
          );
        })}
      </div>
    </div>
  );
};
