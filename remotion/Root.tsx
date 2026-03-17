import React from "react";
import { Composition } from "remotion";
import { DashboardDemo } from "./DashboardDemo";
import { LoginPromoVideo } from "./LoginPromoVideo";

export const RemotionRoot: React.FC = () => {
  return (
    <>
      <Composition
        id="DashboardDemo"
        component={DashboardDemo}
        durationInFrames={900}
        fps={30}
        width={1280}
        height={720}
      />
      <Composition
        id="LoginPromoVideo"
        component={LoginPromoVideo}
        durationInFrames={1500}
        fps={30}
        width={1280}
        height={720}
      />
    </>
  );
};
