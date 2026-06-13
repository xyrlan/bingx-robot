import { serve } from "inngest/next";
import { inngest } from "@/inngest/client";
import { masterTick } from "@/inngest/functions/master-tick";
import { tradingBotWatch } from "@/inngest/functions/trading-bot-watch";
import { dcaBotWatch } from "@/inngest/functions/dca-bot-watch";

// Only Grid (long/short) and DCA watchers are registered. AI PM
// (aiPmTick/aiPmEventHandler/aiPmMonitor) and the extra strategy watchers
// (trailingStopWatch/dcaSpotBotWatch/smaCrossoverWatch) are disabled —
// re-import and add them back here to re-enable. After changing this array,
// run a manual Resync in the Inngest dashboard.
const functions = [
  masterTick,
  tradingBotWatch,
  dcaBotWatch,
];

export const { GET, POST, PUT } = serve({
  client: inngest,
  functions,
});
