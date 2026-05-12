export interface AiPmConfigPublic {
  id: string;
  userId: string;
  bingxApiKeyId: string;
  enabled: boolean;
  mode: 'CONSERVATIVE' | 'BALANCED' | 'AGGRESSIVE' | 'CUSTOM';
  maxCapitalUsdt: string | null;
  maxConcurrentBots: number | null;
  allowedSymbols: string[] | null;
  allowedStrategies: string[] | null;
  killSwitch: boolean;
  paperMode: boolean;
  createdAt: string;
  updatedAt: string;
}

export type { ChatMessagePublic } from '@/services/ai-pm-chat-history.service';
