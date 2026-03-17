import React from "react";
import { AbsoluteFill } from "remotion";
import { colors } from "./styles";
import { Particles } from "./promo/Particles";
import { GridLines } from "./promo/GridLines";
import { PriceLine } from "./promo/PriceLine";
import { Candlesticks } from "./promo/Candlesticks";
import { ExecutionPulses } from "./promo/ExecutionPulses";
import { FloatingNumbers } from "./promo/FloatingNumbers";

export const LoginPromoVideo: React.FC = () => {
  return (
    <AbsoluteFill style={{ background: colors.bg }}>
      <Particles />
      <GridLines />
      <PriceLine />
      <Candlesticks />
      <ExecutionPulses />
      <FloatingNumbers />
    </AbsoluteFill>
  );
};
