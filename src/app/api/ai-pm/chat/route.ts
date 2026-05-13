import {
  streamText,
  stepCountIs,
  convertToModelMessages,
  type UIMessage,
} from 'ai';
import { z } from 'zod';
import { db } from '@/db';
import { getAuthenticatedUser } from '@/services/auth.service';
import { getAiPmConfigById } from '@/services/ai-pm-config.service';
import { getBingxClientByApiKeyId } from '@/services/bingx.service';
import { loadPortfolioState } from '@/lib/ai-pm/portfolio-state';
import { buildAiSdkTools } from '@/lib/ai-pm/ai-sdk-tools';
import { DEFAULT_AI_PM_SYSTEM_PROMPT } from '@/lib/ai-pm/system-prompt';
import { truncateChatMessage } from '@/lib/ai-pm/events';
import {
  persistUserMessage,
  persistAssistantTurn,
} from '@/services/ai-pm-chat-history.service';
import type { ToolExecContext } from '@/lib/ai-pm/chat-tools';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const BodySchema = z.object({
  configId: z.string().regex(UUID_RE, 'Invalid configId'),
  messages: z.array(z.unknown()).min(1),
});

const MODEL_ID = 'anthropic/claude-sonnet-4.6';

export async function POST(req: Request): Promise<Response> {
  const user = await getAuthenticatedUser();
  if (!user) return new Response('Unauthorized', { status: 401 });

  let body: z.infer<typeof BodySchema>;
  try {
    const parsed = BodySchema.safeParse(await req.json());
    if (!parsed.success) {
      return new Response(JSON.stringify({ error: 'Invalid body', issues: parsed.error.issues }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    body = parsed.data;
  } catch {
    return new Response('Invalid JSON', { status: 400 });
  }

  const messages = body.messages as UIMessage[];

  let config;
  try {
    config = await getAiPmConfigById(body.configId);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return new Response(
      JSON.stringify({
        error:
          'AI configuration is corrupted (could not decrypt the Anthropic key). Re-save the key from the AI PM settings page.',
        detail: msg,
      }),
      { status: 500, headers: { 'Content-Type': 'application/json' } },
    );
  }
  if (!config || config.userId !== user.id) {
    return new Response('Config not found', { status: 404 });
  }
  if (!config.enabled) {
    return new Response(
      JSON.stringify({
        error: 'AI is not enabled for this subaccount. Enable it from the AI PM settings page.',
      }),
      { status: 400, headers: { 'Content-Type': 'application/json' } },
    );
  }
  if (config.killSwitch) {
    return new Response(
      JSON.stringify({ error: 'AI is currently disabled (kill switch active).' }),
      { status: 400, headers: { 'Content-Type': 'application/json' } },
    );
  }

  const lastUserMessage = [...messages].reverse().find((m) => m.role === 'user');
  if (!lastUserMessage) {
    return new Response('No user message in payload', { status: 400 });
  }

  // Truncate the latest user message if it exceeds the chat limit. We replace
  // the text part contents in place so the LLM sees the truncated text but the
  // UIMessage shape stays valid for both convertToModelMessages and persistence.
  for (const part of lastUserMessage.parts) {
    if (part.type === 'text') {
      part.text = truncateChatMessage(part.text);
    }
  }

  // Persist the user message before streaming so it shows up in history even
  // if the stream errors out before any assistant content is produced.
  await persistUserMessage(user.id, lastUserMessage);

  const bingxClient = await getBingxClientByApiKeyId(config.bingxApiKeyId);
  const portfolioState = await loadPortfolioState({
    userId: user.id,
    bingxApiKeyId: config.bingxApiKeyId,
    db,
  });

  const ctx: ToolExecContext = {
    userId: user.id,
    configId: config.id,
    chatMessageId: null,
    portfolioState,
    config,
    db,
    bingxClient: bingxClient ?? undefined,
  };

  const tools = buildAiSdkTools(ctx);

  const isKillSwitchOn = async (): Promise<boolean> => {
    try {
      const fresh = await getAiPmConfigById(config.id);
      return Boolean(fresh?.killSwitch);
    } catch {
      // On decrypt failure mid-stream treat as NOT killed; the stream will
      // surface its own error if a tool actually needs the key.
      return false;
    }
  };

  const modelMessages = await convertToModelMessages(messages);
  const result = streamText({
    model: MODEL_ID,
    system: DEFAULT_AI_PM_SYSTEM_PROMPT,
    messages: modelMessages,
    tools,
    stopWhen: [stepCountIs(8), async () => isKillSwitchOn()],
    abortSignal: req.signal,
    experimental_telemetry: {
      isEnabled: true,
      functionId: 'ai-pm-chat',
      metadata: { userId: user.id, configId: config.id },
    },
    onError: ({ error }) => {
      console.error('[ai-pm/chat] streamText error', error);
    },
  });

  // Drain in background so onFinish runs even if the browser disconnects.
  result.consumeStream();

  return result.toUIMessageStreamResponse({
    originalMessages: messages,
    onFinish: async ({ messages: finalMessages }) => {
      try {
        await persistAssistantTurn(user.id, finalMessages);
      } catch (err) {
        console.error('[ai-pm/chat] persist assistant turn failed', err);
      }
    },
    onError: (err) => (err instanceof Error ? err.message : 'Stream error'),
  });
}
