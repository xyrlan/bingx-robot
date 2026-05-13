// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import type { UIMessage } from 'ai';
import { MessageBubble } from '../MessageBubble';

const messages = {
  AiPm: {
    Chat: {
      typing: 'Thinking...',
      viewDecision: 'View decision',
      sendFailed: "Couldn't send. Tap to retry.",
      you: 'You',
      assistant: 'AI',
      toolCallsHeader: 'Actions',
      toolStatus: {
        executed: 'executed',
        rejected: 'rejected',
        failed: 'failed',
        executing: 'executing...',
      },
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

function userMsg(text: string): UIMessage {
  return { id: 'u1', role: 'user', parts: [{ type: 'text', text }] } as UIMessage;
}

function assistantMsg(text: string, toolCalls: unknown[] = []): UIMessage {
  return {
    id: 'a1',
    role: 'assistant',
    parts: [
      { type: 'text', text },
      ...(toolCalls as UIMessage['parts']),
    ],
  } as UIMessage;
}

describe('MessageBubble', () => {
  it('renders user content', () => {
    render(wrap(<MessageBubble message={userMsg('hello')} />));
    expect(screen.getByText('hello')).toBeInTheDocument();
  });

  it('renders assistant text', () => {
    render(wrap(<MessageBubble message={assistantMsg('reply')} />));
    expect(screen.getByText('reply')).toBeInTheDocument();
  });

  it('shows typing dots when pending and empty', () => {
    render(
      wrap(
        <MessageBubble
          message={{ id: 'p', role: 'assistant', parts: [] } as UIMessage}
          pending
        />,
      ),
    );
    expect(screen.getByLabelText('Thinking...')).toBeInTheDocument();
  });

  it('renders tool call cards with deep link to activity when decisionId set', () => {
    const toolPart = {
      type: 'tool-create_bot',
      toolCallId: 'tc-1',
      state: 'output-available',
      input: { symbol: 'BTC-USDT' },
      output: { status: 'EXECUTED', summary: 'created bot ab12', decisionId: 'dec-9' },
    } as unknown as UIMessage['parts'][number];
    render(wrap(<MessageBubble message={assistantMsg('done', [toolPart])} />));
    expect(screen.getByText('create_bot')).toBeInTheDocument();
    expect(screen.getByText(/created bot ab12/)).toBeInTheDocument();
    const link = screen.getByRole('link');
    expect(link).toHaveAttribute('href', expect.stringContaining('focus=dec-9'));
  });

  it('renders failed retry button when failed + onRetry set', () => {
    const onRetry = vi.fn();
    render(wrap(<MessageBubble message={userMsg('boom')} failed onRetry={onRetry} />));
    const btn = screen.getByRole('button', { name: /Couldn't send/i });
    fireEvent.click(btn);
    expect(onRetry).toHaveBeenCalledOnce();
  });
});
