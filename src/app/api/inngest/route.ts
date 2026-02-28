import { serve } from "inngest/next";
import { inngest } from "@/inngest/client";
import { tradingBotWatch } from "@/inngest/functions/trading-bot-watch";

export const { GET, POST, PUT } = serve({
  client: inngest,
  functions: [tradingBotWatch],
});