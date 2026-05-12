import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/services/auth.service', () => ({
  getAuthenticatedUser: vi.fn().mockResolvedValue({ id: 'user-1' }),
}));

const sendMock = vi.fn();
vi.mock('@/inngest/client', () => ({
  inngest: { send: sendMock },
}));

const insertMock = vi.fn();
vi.mock('@/db', () => ({
  db: {
    insert: () => ({ values: (v: unknown) => ({ returning: async () => { insertMock(v); return [{ id: 'msg-1' }]; } }) }),
    query: {
      aiPmConfigs: { findFirst: async () => ({ id: 'cfg-1', userId: 'user-1', enabled: true }) },
    },
  },
}));

describe('POST /api/ai-pm/chat', () => {
  beforeEach(() => {
    sendMock.mockClear();
    insertMock.mockClear();
  });

  it('inserts user message + emits ai-pm/event.chat', async () => {
    const { POST } = await import('@/app/api/ai-pm/chat/route');
    const req = new Request('http://localhost/api/ai-pm/chat', {
      method: 'POST',
      body: JSON.stringify({ configId: '11111111-1111-1111-1111-111111111111', message: 'how is BTC?' }),
      headers: { 'content-type': 'application/json' },
    });
    const res = await POST(req);
    expect(res.status).toBe(200);
    expect(insertMock).toHaveBeenCalled();
    expect(sendMock).toHaveBeenCalledWith(expect.objectContaining({
      name: 'ai-pm/event.chat',
      data: expect.objectContaining({ userMessage: 'how is BTC?' }),
    }));
  });

  it('returns 400 when message empty', async () => {
    const { POST } = await import('@/app/api/ai-pm/chat/route');
    const req = new Request('http://localhost/api/ai-pm/chat', {
      method: 'POST',
      body: JSON.stringify({ configId: '11111111-1111-1111-1111-111111111111', message: '' }),
      headers: { 'content-type': 'application/json' },
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
  });
});
