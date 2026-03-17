import React from "react";
import { interpolate, useCurrentFrame, spring, useVideoConfig } from "remotion";
import { colors, fontFamily, card, badge } from "../styles";

function formatPnl(value: number) {
  return `${value >= 0 ? "+" : ""}${value.toFixed(2)} USDT`;
}

const pnlStats = [
  { label: "Unrealized", value: 207.5 },
  { label: "Realized", value: 425.3 },
  { label: "Total P&L", value: 632.8 },
  { label: "Projected Profit", value: 89.6 },
];

const botsData = [
  {
    symbol: "BTCUSDT",
    type: "Grid Long",
    typeColor: { bg: "rgba(34,197,94,0.1)", text: colors.success },
    status: "RUNNING",
    range: "82,000.00 – 95,000.00",
    grids: 10,
    runtime: "3d 14h",
    extra: "20x • 50 USDT/level • 0.8% TP • Mar 12, 2026",
    unrealized: 145.2,
    realized: 312.4,
    projected: 89.6,
  },
  {
    symbol: "ETHUSDT",
    type: "Grid Long",
    typeColor: { bg: "rgba(34,197,94,0.1)", text: colors.success },
    status: "RUNNING",
    range: "2,800.00 – 3,400.00",
    grids: 8,
    runtime: "2d 8h",
    extra: "15x • 40 USDT/level • 0.6% TP • Mar 13, 2026",
    unrealized: 62.3,
    realized: 88.1,
    projected: 0,
  },
  {
    symbol: "SOLUSDT",
    type: "DCA",
    typeColor: { bg: "rgba(6,182,212,0.1)", text: colors.accent },
    status: "RUNNING",
    range: "120.00 – 180.00",
    grids: 5,
    runtime: "1d 2h",
    extra: "10x • 30 USDT/level • 1.0% TP • Mar 14, 2026",
    unrealized: 0,
    realized: 0,
    projected: 0,
    note: "3/5 orders placed",
  },
  {
    symbol: "XRPUSDT",
    type: "Grid Short",
    typeColor: { bg: "rgba(239,68,68,0.1)", text: colors.danger },
    status: "STOPPED",
    range: "0.50 – 0.65",
    grids: 6,
    runtime: "",
    extra: "5x • 25 USDT/level • 0.5% TP • Mar 10, 2026",
    unrealized: 0,
    realized: 24.8,
    projected: 0,
  },
];

const positions = [
  { side: "LONG", entry: "84,200.00", qty: "0.002", pnl: 98.4, proj: 44.8 },
  { side: "LONG", entry: "85,400.00", qty: "0.002", pnl: 46.8, proj: 44.8 },
];

const orders = [
  { type: "ENTRY", price: "83,444.44", qty: "0.002", status: "OPEN" },
  { type: "ENTRY", price: "86,555.55", qty: "0.002", status: "OPEN" },
  { type: "TP", price: "84,873.60", tp: "84,873.60", status: "OPEN" },
  { type: "TP", price: "86,083.20", tp: "86,083.20", status: "OPEN" },
];

export const BotsPage: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  // Animate unrealized P&L updates
  const pnlUpdate1 = frame > 120;
  const pnlUpdate2 = frame > 160;
  const btcUnrealized = pnlUpdate2 ? 161.4 : pnlUpdate1 ? 152.8 : 145.2;
  const totalUnrealized = pnlUpdate2 ? 223.7 : pnlUpdate1 ? 215.1 : 207.5;

  // Flash effect on update
  const flash1 = frame > 120 && frame < 135;
  const flash2 = frame > 160 && frame < 175;
  const flashBg = flash1 || flash2 ? "rgba(34,197,94,0.12)" : "transparent";

  // Expand BTC details
  const expandFrame = frame - 80;
  const expandProgress = interpolate(expandFrame, [0, 20], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const detailsHeight = expandProgress * 380;

  return (
    <div style={{ fontFamily }}>
      <h1 style={{ fontSize: 24, fontWeight: 700, color: colors.fg, marginBottom: 24 }}>Bots</h1>

      <div style={{ ...card, padding: 16 }}>
        {/* Header */}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
          <span style={{ fontSize: 18, fontWeight: 600, color: colors.fg }}>Your Bots</span>
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

        {/* Filters */}
        <div style={{ display: "flex", gap: 8, marginBottom: 16 }}>
          {["All (4)", "Running (3)", "Stopped (1)"].map((label, i) => (
            <div
              key={label}
              style={{
                padding: "6px 14px",
                borderRadius: 8,
                fontSize: 13,
                fontWeight: 500,
                border: `1px solid ${i === 0 ? colors.primary : colors.border}`,
                background: i === 0 ? colors.primary : "transparent",
                color: i === 0 ? "white" : colors.muted,
              }}
            >
              {label}
            </div>
          ))}
        </div>

        {/* P&L summary */}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 12, marginBottom: 16 }}>
          {pnlStats.map((stat, i) => (
            <div
              key={stat.label}
              style={{
                background: colors.default100,
                borderRadius: 8,
                padding: 12,
                textAlign: "center",
              }}
            >
              <div style={{ fontSize: 12, color: colors.default500 }}>{stat.label}</div>
              <div style={{ fontSize: 14, fontWeight: 600, marginTop: 2, color: colors.success }}>
                {i === 0 ? formatPnl(totalUnrealized) : formatPnl(stat.value)}
              </div>
            </div>
          ))}
        </div>

        {/* Bot list */}
        <div style={{ border: `1px solid ${colors.border}`, borderRadius: 12, overflow: "hidden" }}>
          {botsData.map((bot, botIdx) => (
            <div
              key={bot.symbol}
              style={{
                borderBottom: botIdx < botsData.length - 1 ? `1px solid ${colors.border}` : "none",
              }}
            >
              <div style={{ padding: 16, display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
                <div style={{ flex: 1 }}>
                  <div>
                    <span style={{ fontWeight: 500, fontSize: 15, color: colors.fg }}>{bot.symbol}</span>
                    <span style={badge(bot.typeColor.bg, bot.typeColor.text)}>{bot.type}</span>
                    <span
                      style={badge(
                        bot.status === "RUNNING" ? "rgba(34,197,94,0.1)" : colors.default200,
                        bot.status === "RUNNING" ? colors.success : colors.muted
                      )}
                    >
                      {bot.status}
                    </span>
                  </div>
                  <div style={{ fontSize: 13, color: colors.default500, marginTop: 4 }}>
                    {bot.range} &bull; {bot.grids} {bot.grids === 5 ? "orders" : "grids"}
                    {bot.runtime && ` • Running for ${bot.runtime}`}
                  </div>
                  <div style={{ fontSize: 12, color: colors.default400, marginTop: 2 }}>{bot.extra}</div>
                  {(bot.unrealized !== 0 || bot.realized !== 0) && (
                    <div
                      style={{
                        fontSize: 14,
                        marginTop: 6,
                        background: botIdx === 0 ? flashBg : "transparent",
                        borderRadius: 4,
                        padding: botIdx === 0 ? "2px 4px" : 0,
                        transition: "background 0.3s",
                      }}
                    >
                      {bot.unrealized !== 0 && (
                        <>
                          <span style={{ color: colors.success }}>
                            Unrealized: {formatPnl(botIdx === 0 ? btcUnrealized : bot.unrealized)}
                          </span>
                          <span style={{ margin: "0 8px", color: colors.default400 }}>|</span>
                        </>
                      )}
                      <span style={{ color: colors.success }}>Realized: {formatPnl(bot.realized)}</span>
                      {bot.projected > 0 && (
                        <>
                          <span style={{ margin: "0 8px", color: colors.default400 }}>|</span>
                          <span style={{ color: colors.muted }}>Projected: {formatPnl(bot.projected)}</span>
                        </>
                      )}
                    </div>
                  )}
                  {bot.note && (
                    <div style={{ fontSize: 12, color: colors.muted, marginTop: 6 }}>{bot.note}</div>
                  )}
                </div>
                <div style={{ display: "flex", gap: 8, paddingTop: 4 }}>
                  {bot.status === "RUNNING" ? (
                    <>
                      <div style={{ padding: "6px 14px", borderRadius: 8, border: `1px solid ${colors.border}`, fontSize: 13, color: colors.fg }}>
                        Edit
                      </div>
                      <div style={{ padding: "6px 14px", borderRadius: 8, border: `1px solid rgba(239,68,68,0.5)`, fontSize: 13, color: colors.danger }}>
                        Stop
                      </div>
                    </>
                  ) : (
                    <div style={{ padding: "6px 14px", borderRadius: 8, border: `1px solid rgba(34,197,94,0.5)`, fontSize: 13, color: colors.success }}>
                      Restart
                    </div>
                  )}
                </div>
              </div>

              {/* Expanded details for BTCUSDT */}
              {botIdx === 0 && expandProgress > 0 && (
                <div style={{ overflow: "hidden", maxHeight: detailsHeight, padding: "0 16px 16px", opacity: expandProgress }}>
                  {/* Config grid */}
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 8, marginBottom: 16 }}>
                    {[
                      { label: "Leverage", value: "20x" },
                      { label: "Size/Level", value: "50 USDT" },
                      { label: "TP %", value: "0.8%" },
                      { label: "Created", value: "Mar 12, 2026" },
                    ].map((cell) => (
                      <div key={cell.label} style={{ background: colors.default100, borderRadius: 6, padding: 8 }}>
                        <div style={{ fontSize: 11, color: colors.default500 }}>{cell.label}</div>
                        <div style={{ fontSize: 14, fontWeight: 500, color: colors.fg, marginTop: 2 }}>{cell.value}</div>
                      </div>
                    ))}
                  </div>

                  {/* Positions */}
                  <div style={{ fontSize: 14, fontWeight: 500, color: colors.fg, marginBottom: 8 }}>Open Positions</div>
                  <div style={{ background: "rgba(9,9,11,0.5)", borderRadius: 8, marginBottom: 16 }}>
                    {positions.map((p, i) => (
                      <div
                        key={i}
                        style={{
                          display: "flex",
                          justifyContent: "space-between",
                          alignItems: "center",
                          padding: "8px 12px",
                          borderBottom: i < positions.length - 1 ? `1px solid ${colors.default200}` : "none",
                        }}
                      >
                        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                          <span style={badge("rgba(34,197,94,0.1)", colors.success)}>{p.side}</span>
                          <span style={{ fontSize: 14, color: colors.fg }}>Entry {p.entry} &times; {p.qty}</span>
                        </div>
                        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                          <span style={{ fontSize: 14, color: colors.success }}>{formatPnl(p.pnl)}</span>
                          <span style={{ fontSize: 12, color: colors.muted }}>Proj. {formatPnl(p.proj)}</span>
                        </div>
                      </div>
                    ))}
                  </div>

                  {/* Orders */}
                  <div style={{ fontSize: 14, fontWeight: 500, color: colors.fg, marginBottom: 8 }}>Orders (4 open)</div>
                  <div style={{ background: "rgba(9,9,11,0.5)", borderRadius: 8 }}>
                    {orders.map((o, i) => (
                      <div
                        key={i}
                        style={{
                          display: "flex",
                          justifyContent: "space-between",
                          alignItems: "center",
                          padding: "8px 12px",
                          borderBottom: i < orders.length - 1 ? `1px solid ${colors.default200}` : "none",
                        }}
                      >
                        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                          <span
                            style={badge(
                              o.type === "ENTRY" ? "rgba(59,130,246,0.1)" : "rgba(245,158,11,0.1)",
                              o.type === "ENTRY" ? colors.primary : colors.warning
                            )}
                          >
                            {o.type}
                          </span>
                          <span style={{ fontSize: 14, color: colors.fg }}>
                            @ {o.price}{" "}
                            <span style={{ fontSize: 12, color: colors.muted }}>
                              {o.tp ? `TP: ${o.tp}` : `× ${o.qty}`}
                            </span>
                          </span>
                        </div>
                        <span style={{ fontSize: 12, fontWeight: 500, color: colors.primary }}>{o.status}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};
