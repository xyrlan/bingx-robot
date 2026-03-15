import { serve } from "inngest/next";
import { inngest } from "@/inngest/client";
import { tradingBotWatch } from "@/inngest/functions/trading-bot-watch";
import { dcaBotWatch } from "@/inngest/functions/dca-bot-watch";
import { trailingStopWatch } from "@/inngest/functions/trailing-stop-watch";

/**
 * When INNGEST_USE_CONNECT=1, trading-bot-watch runs on the Connect worker (Railway/Render)
 * instead of Vercel, avoiding Fast Origin Transfer. The serve route still syncs for other
 * functions and keeps the Inngest Vercel integration working.
 */
const functions = process.env.INNGEST_USE_CONNECT === '1' ? [] : [tradingBotWatch, dcaBotWatch, trailingStopWatch];

export const { GET, POST, PUT } = serve({
  client: inngest,
  functions,
});