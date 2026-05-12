export const AI_PM_EVENT_NAMES = [
  'ai-pm/event.fill',
  'ai-pm/event.error',
  'ai-pm/event.drawdown',
  'ai-pm/event.funding-flip',
  'ai-pm/event.chat',
] as const;

export type AiPmEventName = (typeof AI_PM_EVENT_NAMES)[number];

export interface BaseEventPayload {
  configId: string;
  emittedAt: string;
}

export interface FillPayload extends BaseEventPayload {
  symbol: string;
  botId: string;
  botKind: 'real' | 'paper';
  side: 'LONG' | 'SHORT';
  fillPrice: string;
  quantity: string;
  orderType: 'ENTRY' | 'TAKE_PROFIT' | 'STOP_LOSS';
}

export interface ErrorPayload extends BaseEventPayload {
  symbol: string;
  botId: string;
  botKind: 'real' | 'paper';
  errorKind:
    | 'API_ERROR'
    | 'INSUFFICIENT_MARGIN'
    | 'INVALID_PARAMS'
    | 'ORDER_REJECTED'
    | 'UNKNOWN';
  message: string;
}

export interface DrawdownPayload extends BaseEventPayload {
  symbol: string;
  botId: string;
  botKind: 'real' | 'paper';
  drawdownPct: number;
  thresholdPct: number;
  currentPnlUsdt: string;
  capitalUsdt: string;
}

export interface FundingFlipPayload extends BaseEventPayload {
  symbol: string;
  previousRate: number;
  currentRate: number;
}

export interface ChatPayload extends BaseEventPayload {
  symbol: null;
  chatMessageId: string;
  userMessage: string;
  assistantPlaceholderId: string;
}

export type AiPmEventPayload =
  | FillPayload
  | ErrorPayload
  | DrawdownPayload
  | FundingFlipPayload
  | ChatPayload;

export type AiTriggerEnum =
  | 'EVENT_FILL'
  | 'EVENT_ERROR'
  | 'EVENT_DRAWDOWN'
  | 'EVENT_FUNDING_FLIP'
  | 'CHAT';

export function mapNameToEnum(name: AiPmEventName): AiTriggerEnum {
  switch (name) {
    case 'ai-pm/event.fill':
      return 'EVENT_FILL';
    case 'ai-pm/event.error':
      return 'EVENT_ERROR';
    case 'ai-pm/event.drawdown':
      return 'EVENT_DRAWDOWN';
    case 'ai-pm/event.funding-flip':
      return 'EVENT_FUNDING_FLIP';
    case 'ai-pm/event.chat':
      return 'CHAT';
  }
}

const ERROR_MESSAGE_MAX = 500;
const CHAT_MESSAGE_MAX = 2000;

export function truncateErrorMessage(msg: string): string {
  return msg.length > ERROR_MESSAGE_MAX ? msg.slice(0, ERROR_MESSAGE_MAX) : msg;
}

export function truncateChatMessage(msg: string): string {
  return msg.length > CHAT_MESSAGE_MAX ? msg.slice(0, CHAT_MESSAGE_MAX) : msg;
}
