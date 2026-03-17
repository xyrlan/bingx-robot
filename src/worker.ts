/**
 * Inngest Connect Worker - runs trading-bot-watch outside Vercel to avoid Fast Origin Transfer.
 * Deploy to Railway, Render, Fly.io, or any long-running Node host.
 *
 * Required env: DATABASE_URL, INNGEST_SIGNING_KEY, INNGEST_EVENT_KEY (for prod)
 * Optional: INNGEST_DEV=1 for local dev with inngest-cli
 */
import 'dotenv/config';
import { createServer } from 'http';
import { connect, ConnectionState } from 'inngest/connect';
import { inngest } from '@/inngest/client';
import { tradingBotWatch } from '@/inngest/functions/trading-bot-watch';
import { dcaBotWatch } from '@/inngest/functions/dca-bot-watch';
import { trailingStopWatch } from '@/inngest/functions/trailing-stop-watch';
import { dcaSpotBotWatch } from '@/inngest/functions/dca-spot-bot-watch';

const PORT = Number(process.env.WORKER_PORT ?? 8080);

(async () => {
  const connection = await connect({
    apps: [
      {
        client: inngest,
        functions: [tradingBotWatch, dcaBotWatch, trailingStopWatch, dcaSpotBotWatch],
      },
    ],
    instanceId: process.env.HOSTNAME ?? process.env.RENDER_INSTANCE_ID ?? undefined,
    maxWorkerConcurrency: 5,
  });

  console.log('[Worker] Connected to Inngest:', connection.state);

  const httpServer = createServer((req, res) => {
    if (req.url === '/ready' || req.url === '/health') {
      if (connection.state === ConnectionState.ACTIVE) {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('OK');
      } else {
        res.writeHead(503, { 'Content-Type': 'text/plain' });
        res.end('NOT_READY');
      }
      return;
    }
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('NOT_FOUND');
  });

  httpServer.listen(PORT, () => {
    console.log(`[Worker] HTTP server listening on port ${PORT} (health: /ready)`);
  });

  await connection.closed;
  console.log('[Worker] Shut down');
  httpServer.close();
})();
