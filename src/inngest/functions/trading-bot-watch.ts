import { inngest } from '@/inngest/client';
import {
  getRunningBots,
  getBingxClient,
  updateBotCurrentOrder,
  setBotStatus,
} from '@/services/bingx.service';

export const tradingBotWatch = inngest.createFunction(
  {
    id: 'trading-bot-watch',
    name: 'Trading Bot Watch',
    retries: 3,
  },
  { cron: '*/1 * * * *' },
  async ({ step, logger }) => {
    const bots = await step.run('fetch-running-bots', async () => {
      return getRunningBots();
    });

    if (bots.length === 0) {
      logger.info('No running bots to process');
      return { processed: 0 };
    }

    let processed = 0;

    for (const bot of bots) {
      await step.run(`process-bot-${bot.id}`, async () => {
        const client = await getBingxClient(bot.userId);
        if (!client) {
          logger.warn(`No BingX keys for user ${bot.userId}, stopping bot ${bot.id}`);
          await setBotStatus(bot.id, bot.userId, 'STOPPED');
          return;
        }

        try {
          const openOrders = (await client.get('/openApi/swap/v2/trade/openOrders', {
            symbol: bot.symbol,
          })) as { orders?: Array<{ orderId: string; symbol: string; status: string }> };

          const orders = Array.isArray(openOrders) ? openOrders : openOrders?.orders ?? [];
          const openOrderIds = new Set(orders.map((o: { orderId: string }) => o.orderId));

          const currentOrderId = bot.currentOrderId;
          const orderStillOpen = currentOrderId && openOrderIds.has(currentOrderId);

          if (!orderStillOpen && currentOrderId) {
            logger.info(`Order ${currentOrderId} filled or cancelled for bot ${bot.id}, placing replacement`);
          }

          const needsNewOrder = !orderStillOpen;

          if (needsNewOrder) {
            const priceMin = Number(bot.priceMin);
            const priceMax = Number(bot.priceMax);
            const midPrice = (priceMin + priceMax) / 2;

            const orderResult = (await client.post('/openApi/swap/v2/trade/order', {
              symbol: bot.symbol,
              side: 'BUY',
              type: 'LIMIT',
              quantity: 0.001,
              price: midPrice,
              positionSide: 'LONG',
            })) as { orderId?: string; order?: { orderId?: string } };

            const newOrderId =
              orderResult?.orderId ?? orderResult?.order?.orderId ?? null;
            if (newOrderId) {
              await updateBotCurrentOrder(bot.id, String(newOrderId));
              processed++;
              logger.info(`Placed order ${newOrderId} for bot ${bot.id}`);
            }
          }
        } catch (err) {
          logger.error(`Error processing bot ${bot.id}:`, err);
          throw err;
        }
      });
    }

    return { processed };
  }
);
