import { describe, it, expect, vi, beforeEach } from 'vitest';

// --- Mocks --------------------------------------------------------------

const getAuthMock = vi.fn();
const getConfigMock = vi.fn();
const getBingxMock = vi.fn();
const loadPortfolioMock = vi.fn();
const persistUserMock = vi.fn().mockResolvedValue(undefined);
const persistAssistantMock = vi.fn().mockResolvedValue(undefined);

vi.mock('@/services/auth.service', () => ({
  getAuthenticatedUser: () => getAuthMock(),
}));
vi.mock('@/services/ai-pm-config.service', () => ({
  getAiPmConfigById: (id: string) => getConfigMock(id),
}));
vi.mock('@/services/bingx.service', () => ({
  getBingxClientByApiKeyId: (id: string) => getBingxMock(id),
}));
vi.mock('@/lib/ai-pm/portfolio-state', () => ({
  loadPortfolioState: (params: unknown) => loadPortfolioMock(params),
}));
vi.mock('@/services/ai-pm-chat-history.service', () => ({
  persistUserMessage: (...args: unknown[]) => persistUserMock(...args),
  persistAssistantTurn: (...args: unknown[]) => persistAssistantMock(...args),
}));

// streamText is the heavy hitter. Stub it to return a tiny object whose
// `consumeStream` is a no-op and `toUIMessageStreamResponse` returns a Response
// we can inspect.
const streamTextMock = vi.fn();
const toUIMessageStreamResponseMock = vi.fn().mockReturnValue(new Response('ok', { status: 200 }));
const consumeStreamMock = vi.fn();
vi.mock('ai', () => ({
  streamText: (...args: unknown[]) => {
    streamTextMock(...args);
    return {
      consumeStream: consumeStreamMock,
      toUIMessageStreamResponse: (opts: unknown) => toUIMessageStreamResponseMock(opts),
    };
  },
  stepCountIs: (n: number) => ({ kind: 'stepCount', n }),
  convertToModelMessages: (m: unknown) => m,
  // not used by the route but referenced in the import; keep type compat.
  tool: (def: unknown) => def,
}));

vi.mock('@/lib/ai-pm/ai-sdk-tools', () => ({
  buildAiSdkTools: vi.fn(() => ({ read_portfolio: { description: 'fake' } })),
}));

vi.mock('@/db', () => ({ db: {} }));

import { POST } from '@/app/api/ai-pm/chat/route';

// --- Tests --------------------------------------------------------------

const VALID_USER = { id: '00000000-0000-0000-0000-000000000001' };
const VALID_CFG = '00000000-0000-0000-0000-000000000010';
const goodConfig = {
  id: VALID_CFG,
  userId: VALID_USER.id,
  bingxApiKeyId: '00000000-0000-0000-0000-0000000000a0',
  enabled: true,
  killSwitch: false,
  paperMode: true,
  anthropicApiKey: 'sk',
};

function makeReq(body: unknown): Request {
  return new Request('http://localhost/api/ai-pm/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  getAuthMock.mockReset();
  getConfigMock.mockReset();
  getBingxMock.mockReset().mockResolvedValue({});
  loadPortfolioMock.mockReset().mockResolvedValue({ runningBots: [], capitalUsedUsdt: 0, bingxApiKeyId: 'k1' });
  persistUserMock.mockClear();
  persistAssistantMock.mockClear();
  streamTextMock.mockClear();
  toUIMessageStreamResponseMock.mockClear();
  consumeStreamMock.mockClear();
});

describe('POST /api/ai-pm/chat', () => {
  it('returns 401 when no authenticated user', async () => {
    getAuthMock.mockResolvedValue(null);
    const res = await POST(
      makeReq({ configId: VALID_CFG, messages: [{ id: 'm1', role: 'user', parts: [{ type: 'text', text: 'hi' }] }] }),
    );
    expect(res.status).toBe(401);
    expect(streamTextMock).not.toHaveBeenCalled();
  });

  it('returns 400 on invalid body shape', async () => {
    getAuthMock.mockResolvedValue(VALID_USER);
    const res = await POST(makeReq({ configId: 'not-a-uuid', messages: [] }));
    expect(res.status).toBe(400);
  });

  it('returns 404 when config not found or owned by another user', async () => {
    getAuthMock.mockResolvedValue(VALID_USER);
    getConfigMock.mockResolvedValue(null);
    const res = await POST(
      makeReq({ configId: VALID_CFG, messages: [{ id: 'm1', role: 'user', parts: [{ type: 'text', text: 'hi' }] }] }),
    );
    expect(res.status).toBe(404);
  });

  it('returns 400 when AI is not enabled', async () => {
    getAuthMock.mockResolvedValue(VALID_USER);
    getConfigMock.mockResolvedValue({ ...goodConfig, enabled: false });
    const res = await POST(
      makeReq({ configId: VALID_CFG, messages: [{ id: 'm1', role: 'user', parts: [{ type: 'text', text: 'hi' }] }] }),
    );
    expect(res.status).toBe(400);
  });

  it('returns 400 when kill switch is active', async () => {
    getAuthMock.mockResolvedValue(VALID_USER);
    getConfigMock.mockResolvedValue({ ...goodConfig, killSwitch: true });
    const res = await POST(
      makeReq({ configId: VALID_CFG, messages: [{ id: 'm1', role: 'user', parts: [{ type: 'text', text: 'hi' }] }] }),
    );
    expect(res.status).toBe(400);
  });

  it('happy path: persists user message, calls streamText, consumes stream, returns SSE', async () => {
    getAuthMock.mockResolvedValue(VALID_USER);
    getConfigMock.mockResolvedValue(goodConfig);
    const res = await POST(
      makeReq({
        configId: VALID_CFG,
        messages: [{ id: 'm1', role: 'user', parts: [{ type: 'text', text: 'hello' }] }],
      }),
    );
    expect(res.status).toBe(200);
    expect(persistUserMock).toHaveBeenCalledOnce();
    expect(streamTextMock).toHaveBeenCalledOnce();
    expect(consumeStreamMock).toHaveBeenCalledOnce();
    expect(toUIMessageStreamResponseMock).toHaveBeenCalledOnce();
    const opts = streamTextMock.mock.calls[0][0] as { model: string; tools: unknown };
    expect(opts.model).toBe('anthropic/claude-sonnet-4.6');
    expect(opts.tools).toBeTruthy();
  });
});
