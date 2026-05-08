import { serve } from "inngest/next";
import { inngest } from "@/inngest/client";
import { tradingBotWatch } from "@/inngest/functions/trading-bot-watch";
// Temporarily disabled to reduce Inngest executions — only Grid Long is in use.
// import { dcaBotWatch } from "@/inngest/functions/dca-bot-watch";
// import { trailingStopWatch } from "@/inngest/functions/trailing-stop-watch";
// import { dcaSpotBotWatch } from "@/inngest/functions/dca-spot-bot-watch";
// import { smaCrossoverWatch } from "@/inngest/functions/sma-crossover-watch";

const functions = [tradingBotWatch];

export const { GET, POST, PUT } = serve({
  client: inngest,
  functions,
});