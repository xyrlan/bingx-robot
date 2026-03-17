import React from "react";
import { AbsoluteFill, Sequence } from "remotion";
import { colors, fontFamily } from "./styles";
import { Splash } from "./scenes/Splash";
import { Sidebar } from "./scenes/Sidebar";
import { OverviewPage } from "./scenes/OverviewPage";
import { BotsPage } from "./scenes/BotsPage";
import { AccountsPage } from "./scenes/AccountsPage";
import { Outro } from "./scenes/Outro";

// Timeline (in frames at 30fps):
// 0–90:    Splash (3s)
// 80–350:  Overview page with sidebar (9s)
// 350–620: Bots page (9s)
// 620–780: Accounts page (5.3s)
// 780–900: Outro (4s)

export const DashboardDemo: React.FC = () => {
  return (
    <AbsoluteFill style={{ background: colors.bg, fontFamily }}>
      {/* Scene 1: Splash */}
      <Sequence durationInFrames={90}>
        <Splash />
      </Sequence>

      {/* Scene 2-5: Dashboard layout + Overview page */}
      <Sequence from={80} durationInFrames={270}>
        <AbsoluteFill>
          <Sidebar activePage="Overview" />
          {/* Header */}
          <div
            style={{
              position: "absolute",
              top: 0,
              left: 256,
              right: 0,
              height: 64,
              borderBottom: `1px solid ${colors.border}`,
              background: colors.bg,
              display: "flex",
              alignItems: "center",
              justifyContent: "flex-end",
              padding: "0 24px",
              zIndex: 5,
            }}
          >
            <div
              style={{
                padding: "8px 16px",
                borderRadius: 8,
                border: `1px solid ${colors.border}`,
                fontSize: 13,
                color: colors.muted,
              }}
            >
              Sign out
            </div>
          </div>
          {/* Content */}
          <div style={{ position: "absolute", left: 256, top: 64, right: 0, bottom: 0, padding: 24 }}>
            <div style={{ maxWidth: 700, margin: "0 auto" }}>
              <OverviewPage />
            </div>
          </div>
        </AbsoluteFill>
      </Sequence>

      {/* Scene 6-9: Bots page */}
      <Sequence from={350} durationInFrames={270}>
        <AbsoluteFill>
          <Sidebar activePage="Bots" />
          {/* Header */}
          <div
            style={{
              position: "absolute",
              top: 0,
              left: 256,
              right: 0,
              height: 64,
              borderBottom: `1px solid ${colors.border}`,
              background: colors.bg,
              display: "flex",
              alignItems: "center",
              justifyContent: "flex-end",
              padding: "0 24px",
              zIndex: 5,
            }}
          >
            <div
              style={{
                padding: "8px 16px",
                borderRadius: 8,
                border: `1px solid ${colors.border}`,
                fontSize: 13,
                color: colors.muted,
              }}
            >
              Sign out
            </div>
          </div>
          {/* Content */}
          <div style={{ position: "absolute", left: 256, top: 64, right: 0, bottom: 0, padding: 24, overflowY: "hidden" }}>
            <div style={{ maxWidth: 700, margin: "0 auto" }}>
              <BotsPage />
            </div>
          </div>
        </AbsoluteFill>
      </Sequence>

      {/* Scene 10-11: Accounts page */}
      <Sequence from={620} durationInFrames={160}>
        <AbsoluteFill>
          <Sidebar activePage="Accounts" />
          {/* Header */}
          <div
            style={{
              position: "absolute",
              top: 0,
              left: 256,
              right: 0,
              height: 64,
              borderBottom: `1px solid ${colors.border}`,
              background: colors.bg,
              display: "flex",
              alignItems: "center",
              justifyContent: "flex-end",
              padding: "0 24px",
              zIndex: 5,
            }}
          >
            <div
              style={{
                padding: "8px 16px",
                borderRadius: 8,
                border: `1px solid ${colors.border}`,
                fontSize: 13,
                color: colors.muted,
              }}
            >
              Sign out
            </div>
          </div>
          {/* Content */}
          <div style={{ position: "absolute", left: 256, top: 64, right: 0, bottom: 0, padding: 24 }}>
            <div style={{ maxWidth: 700, margin: "0 auto" }}>
              <AccountsPage />
            </div>
          </div>
        </AbsoluteFill>
      </Sequence>

      {/* Scene 12: Outro */}
      <Sequence from={780}>
        <Outro />
      </Sequence>
    </AbsoluteFill>
  );
};
