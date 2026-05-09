import { serve } from "inngest/next";
import { inngest } from "@/inngest/client";
import { masterTick } from "@/inngest/functions/master-tick";
import { tradingBotWatch } from "@/inngest/functions/trading-bot-watch";
import { dcaBotWatch } from "@/inngest/functions/dca-bot-watch";
import { trailingStopWatch } from "@/inngest/functions/trailing-stop-watch";
import { dcaSpotBotWatch } from "@/inngest/functions/dca-spot-bot-watch";
import { smaCrossoverWatch } from "@/inngest/functions/sma-crossover-watch";

const functions = [
  masterTick,
  tradingBotWatch,
  dcaBotWatch,
  trailingStopWatch,
  dcaSpotBotWatch,
  smaCrossoverWatch,
];

export const { GET, POST, PUT } = serve({
  client: inngest,
  functions,
});
