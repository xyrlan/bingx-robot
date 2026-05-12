import type { AiPmEventName, AiPmEventPayload, FillPayload, ErrorPayload } from '@/lib/ai-pm/events';
import { truncateErrorMessage } from '@/lib/ai-pm/events';
import { getAiPmConfigByBingxApiKeyId } from '@/services/ai-pm-config.service';

export interface EmitFillParams {
  sendEventFn: (event: { name: AiPmEventName; data: AiPmEventPayload }) => Promise<void> | void;
  lookupConfigByApiKeyIdFn?: typeof getAiPmConfigByBingxApiKeyId;
  apiKeyId: string;
  botId: string;
  botKind: 'real' | 'paper';
  symbol: string;
  side: 'LONG' | 'SHORT';
  fillPrice: string;
  quantity: string;
  orderType: 'ENTRY' | 'TAKE_PROFIT' | 'STOP_LOSS';
}

export async function maybeEmitFillEvent(params: EmitFillParams): Promise<void> {
  const lookup = params.lookupConfigByApiKeyIdFn ?? getAiPmConfigByBingxApiKeyId;
  const config = await lookup(params.apiKeyId);
  if (!config) return;

  const data: FillPayload = {
    configId: config.id,
    emittedAt: new Date().toISOString(),
    symbol: params.symbol,
    botId: params.botId,
    botKind: params.botKind,
    side: params.side,
    fillPrice: params.fillPrice,
    quantity: params.quantity,
    orderType: params.orderType,
  };
  await params.sendEventFn({ name: 'ai-pm/event.fill', data });
}

export interface EmitErrorParams {
  sendEventFn: (event: { name: AiPmEventName; data: AiPmEventPayload }) => Promise<void> | void;
  lookupConfigByApiKeyIdFn?: typeof getAiPmConfigByBingxApiKeyId;
  apiKeyId: string;
  botId: string;
  botKind: 'real' | 'paper';
  symbol: string;
  errorKind: ErrorPayload['errorKind'];
  message: string;
}

export async function maybeEmitErrorEvent(params: EmitErrorParams): Promise<void> {
  const lookup = params.lookupConfigByApiKeyIdFn ?? getAiPmConfigByBingxApiKeyId;
  const config = await lookup(params.apiKeyId);
  if (!config) return;

  const data: ErrorPayload = {
    configId: config.id,
    emittedAt: new Date().toISOString(),
    symbol: params.symbol,
    botId: params.botId,
    botKind: params.botKind,
    errorKind: params.errorKind,
    message: truncateErrorMessage(params.message),
  };
  await params.sendEventFn({ name: 'ai-pm/event.error', data });
}
