import { describe, it, expect } from 'vitest';
import { maybeEmitFillEvent, maybeEmitErrorEvent } from '@/lib/ai-pm/emit-events';

describe('maybeEmitFillEvent', () => {
  it('emits when bot is AI-managed (real)', async () => {
    const sent: unknown[] = [];
    const sendEventFn = async (e: unknown) => { sent.push(e); };
    const lookupConfigFn = async () => ({ id: 'cfg1' });

    await maybeEmitFillEvent({
      sendEventFn,
      lookupConfigByApiKeyIdFn: lookupConfigFn,
      apiKeyId: 'k1',
      botId: 'b1',
      botKind: 'real',
      symbol: 'BTC-USDT',
      side: 'LONG',
      fillPrice: '50000',
      quantity: '0.01',
      orderType: 'ENTRY',
    });

    expect(sent).toHaveLength(1);
    expect((sent[0] as { name: string }).name).toBe('ai-pm/event.fill');
  });

  it('does not emit when no config matches apiKeyId', async () => {
    const sent: unknown[] = [];
    const sendEventFn = async (e: unknown) => { sent.push(e); };
    const lookupConfigFn = async () => null;

    await maybeEmitFillEvent({
      sendEventFn,
      lookupConfigByApiKeyIdFn: lookupConfigFn,
      apiKeyId: 'k1',
      botId: 'b1',
      botKind: 'real',
      symbol: 'BTC-USDT',
      side: 'LONG',
      fillPrice: '50000',
      quantity: '0.01',
      orderType: 'ENTRY',
    });

    expect(sent).toHaveLength(0);
  });
});

describe('maybeEmitErrorEvent', () => {
  it('truncates messages over 500 chars', async () => {
    const sent: Array<{ name: string; data: { message: string } }> = [];
    await maybeEmitErrorEvent({
      sendEventFn: async (e) => { sent.push(e as { name: string; data: { message: string } }); },
      lookupConfigByApiKeyIdFn: async () => ({ id: 'cfg1' }),
      apiKeyId: 'k1',
      botId: 'b1',
      botKind: 'real',
      symbol: 'BTC-USDT',
      errorKind: 'API_ERROR',
      message: 'x'.repeat(700),
    });
    expect(sent[0].data.message.length).toBeLessThanOrEqual(500);
  });
});
