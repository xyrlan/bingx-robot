// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { ChatClient } from '../ChatClient';

const messages = {
  AiPm: {
    Chat: {
      title: 'AI Chat',
      subtitle: 'Talk',
      placeholder: 'Ask the portfolio manager...',
      send: 'Send',
      loadOlder: 'Load older messages',
      noMessagesYet: 'No messages yet. Say hi.',
      configLabel: 'Subaccount',
      killSwitchActive: 'KILL',
      sendFailed: "Couldn't send. Tap to retry.",
      noResponse: 'No response after 60s. Try again.',
      sessionExpired: 'Session expired',
      noConfigsCta: 'Set up first',
      typing: 'Thinking...',
      viewDecision: 'View decision',
      you: 'You',
      assistant: 'AI',
    },
  },
};

function wrap(node: React.ReactNode) {
  return (
    <NextIntlClientProvider locale="en" messages={messages}>
      {node}
    </NextIntlClientProvider>
  );
}

const CONFIG = { id: 'cfg-1', label: 'main', enabled: true, killSwitch: false };

describe('ChatClient', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    // Fake only setInterval (poll loop). Leave setTimeout alone so
    // @testing-library/react's waitFor() can still poll for assertions.
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('renders initial messages', () => {
    render(wrap(
      <ChatClient
        configs={[CONFIG]}
        initialMessages={[
          { id: 'm1', role: 'user', content: 'hi', decisionId: null, toolCalls: null, createdAt: '2026-05-12T00:00:00Z' },
          { id: 'm2', role: 'assistant', content: 'hello', decisionId: null, toolCalls: null, createdAt: '2026-05-12T00:00:01Z' },
        ]}
        initialOldestCursor={null}
      />,
    ));
    expect(screen.getByText('hi')).toBeInTheDocument();
    expect(screen.getByText('hello')).toBeInTheDocument();
  });

  it('sends message then polls and renders assistant reply', async () => {
    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, chatMessageId: 'u1' }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ messages: [], nextCursor: null }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        messages: [{ id: 'a1', role: 'assistant', content: 'reply', decisionId: null, toolCalls: null, createdAt: new Date().toISOString() }],
        nextCursor: null,
      }), { status: 200 }));

    render(wrap(
      <ChatClient configs={[CONFIG]} initialMessages={[]} initialOldestCursor={null} />,
    ));

    const ta = screen.getByPlaceholderText('Ask the portfolio manager...') as HTMLTextAreaElement;
    fireEvent.change(ta, { target: { value: 'ping' } });
    fireEvent.keyDown(ta, { key: 'Enter', shiftKey: false });

    await waitFor(() => {
      expect(screen.getByText('ping')).toBeInTheDocument();
    });

    await act(async () => { await vi.advanceTimersByTimeAsync(2100); });
    await act(async () => { await vi.advanceTimersByTimeAsync(2100); });

    await waitFor(() => {
      expect(screen.getByText('reply')).toBeInTheDocument();
    });

    expect(fetchMock).toHaveBeenCalledTimes(3); // 1 POST + 2 history GETs
    expect(fetchMock.mock.calls[0][0]).toBe('/api/ai-pm/chat');
    expect(fetchMock.mock.calls[1][0]).toMatch(/\/api\/ai-pm\/chat\/history/);
    expect(fetchMock.mock.calls[2][0]).toMatch(/\/api\/ai-pm\/chat\/history/);
  });

  it('marks user message failed when POST errors', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ error: 'boom' }), { status: 500 }));

    render(wrap(
      <ChatClient configs={[CONFIG]} initialMessages={[]} initialOldestCursor={null} />,
    ));

    const ta = screen.getByPlaceholderText('Ask the portfolio manager...') as HTMLTextAreaElement;
    fireEvent.change(ta, { target: { value: 'x' } });
    fireEvent.keyDown(ta, { key: 'Enter', shiftKey: false });

    await waitFor(() => {
      expect(screen.getByText(/Couldn't send/i)).toBeInTheDocument();
    });
  });

  it('ignores empty assistant placeholder rows during poll', async () => {
    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, chatMessageId: 'u1' }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        messages: [{ id: 'pl1', role: 'assistant', content: '', decisionId: null, toolCalls: null, createdAt: new Date().toISOString() }],
        nextCursor: null,
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        messages: [{ id: 'pl1', role: 'assistant', content: 'final answer', decisionId: null, toolCalls: null, createdAt: new Date().toISOString() }],
        nextCursor: null,
      }), { status: 200 }));

    render(wrap(
      <ChatClient configs={[CONFIG]} initialMessages={[]} initialOldestCursor={null} />,
    ));

    const ta = screen.getByPlaceholderText('Ask the portfolio manager...') as HTMLTextAreaElement;
    fireEvent.change(ta, { target: { value: 'hello' } });
    fireEvent.keyDown(ta, { key: 'Enter', shiftKey: false });

    await waitFor(() => { expect(screen.getByText('hello')).toBeInTheDocument(); });

    await act(async () => { await vi.advanceTimersByTimeAsync(2100); });
    expect(screen.queryByText('final answer')).not.toBeInTheDocument();

    await act(async () => { await vi.advanceTimersByTimeAsync(2100); });
    await waitFor(() => { expect(screen.getByText('final answer')).toBeInTheDocument(); });
  });

  it('failed user message retry button re-sends the same content', async () => {
    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: 'boom' }), { status: 500 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, chatMessageId: 'u2' }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ messages: [], nextCursor: null }), { status: 200 }));

    render(wrap(
      <ChatClient configs={[CONFIG]} initialMessages={[]} initialOldestCursor={null} />,
    ));

    const ta = screen.getByPlaceholderText('Ask the portfolio manager...') as HTMLTextAreaElement;
    fireEvent.change(ta, { target: { value: 'retry-me' } });
    fireEvent.keyDown(ta, { key: 'Enter', shiftKey: false });

    const retryBtn = await screen.findByRole('button', { name: /Couldn't send/i });
    fireEvent.click(retryBtn);

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });
    const retryBody = JSON.parse((fetchMock.mock.calls[1][1] as { body: string }).body);
    expect(retryBody.message).toBe('retry-me');
  });

  it('shows timeout toast after 180s of empty poll responses', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, chatMessageId: 'u1' }), { status: 200 }));
    // 90 empty polls
    for (let i = 0; i < 91; i++) {
      fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ messages: [], nextCursor: null }), { status: 200 }));
    }

    render(wrap(
      <ChatClient configs={[CONFIG]} initialMessages={[]} initialOldestCursor={null} />,
    ));

    const ta = screen.getByPlaceholderText('Ask the portfolio manager...') as HTMLTextAreaElement;
    fireEvent.change(ta, { target: { value: 'x' } });
    fireEvent.keyDown(ta, { key: 'Enter', shiftKey: false });

    for (let i = 0; i < 91; i++) {
      await act(async () => { await vi.advanceTimersByTimeAsync(2100); });
    }

    await waitFor(() => {
      expect(screen.getByText(/No response after/i)).toBeInTheDocument();
    });
  });
});
