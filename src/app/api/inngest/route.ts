import { serve } from "inngest/next";
import { inngest } from "@/inngest/client";
import { tradingBotWatch } from "@/inngest/functions/trading-bot-watch";
import { dcaBotWatch } from "@/inngest/functions/dca-bot-watch";
import { trailingStopWatch } from "@/inngest/functions/trailing-stop-watch";
import { dcaSpotBotWatch } from "@/inngest/functions/dca-spot-bot-watch";

const functions = [tradingBotWatch, dcaBotWatch, trailingStopWatch, dcaSpotBotWatch];

export const { GET, POST, PUT } = serve({
  client: inngest,
  functions,
});