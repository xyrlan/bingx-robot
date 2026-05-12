// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { MessageBubble } from '../MessageBubble';

const messages = {
  AiPm: {
    Chat: {
      typing: 'Thinking...',
      viewDecision: 'View decision',
      sendFailed: 'Couldn\'t send. Tap to retry.',
      you: 'You',
      assistant: 'AI',
      toolCallsHeader: 'Actions',
      'toolStatus.executed': 'executed',
      'toolStatus.rejected': 'rejected',
      'toolStatus.failed': 'failed',
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

describe('MessageBubble', () => {
  it('renders user content', () => {
    render(wrap(
      <MessageBubble
        role="user"
        content="hello"
        decisionId={null}
        toolCalls={null}
        createdAt="2026-05-12T00:00:00Z"
      />,
    ));
    expect(screen.getByText('hello')).toBeInTheDocument();
  });

  it('renders assistant content', () => {
    render(wrap(
      <MessageBubble
        role="assistant"
        content="hi back"
        decisionId={null}
        toolCalls={null}
        createdAt="2026-05-12T00:00:00Z"
      />,
    ));
    expect(screen.getByText('hi back')).toBeInTheDocument();
  });

  it('renders pending typing indicator instead of content', () => {
    render(wrap(
      <MessageBubble
        role="assistant"
        content=""
        decisionId={null}
        toolCalls={null}
        createdAt="2026-05-12T00:00:00Z"
        pending
      />,
    ));
    expect(screen.getByText('Thinking...')).toBeInTheDocument();
  });

  it('renders decision badge link when decisionId is present', () => {
    render(wrap(
      <MessageBubble
        role="assistant"
        content="done"
        decisionId="dec-123"
        toolCalls={null}
        createdAt="2026-05-12T00:00:00Z"
      />,
    ));
    const link = screen.getByRole('link', { name: /view decision/i });
    expect(link).toHaveAttribute('href', '/dashboard/ai-pm/activity?focus=dec-123');
  });

  it('renders failed retry hint for user role', () => {
    render(wrap(
      <MessageBubble
        role="user"
        content="x"
        decisionId={null}
        toolCalls={null}
        createdAt="2026-05-12T00:00:00Z"
        failed
      />,
    ));
    expect(screen.getByText(/Couldn't send/i)).toBeInTheDocument();
  });

  it('renders toolCalls list when provided', () => {
    render(wrap(
      <MessageBubble
        role="assistant"
        content="all good"
        decisionId={null}
        toolCalls={[
          { toolName: 'read_portfolio', args: {}, status: 'EXECUTED', decisionId: null, summary: '1 bot' },
          { toolName: 'create_bot', args: { symbol: 'BTC-USDT' }, status: 'EXECUTED', decisionId: 'dec-1', summary: 'created bot abc' },
          { toolName: 'create_bot', args: { symbol: 'ETH-USDT' }, status: 'REJECTED_GUARDRAIL', decisionId: 'dec-2', summary: 'guardrail tripped' },
        ]}
        createdAt="2026-05-12T00:00:00Z"
      />,
    ));
    expect(screen.getByText('Actions')).toBeInTheDocument();
    expect(screen.getByText(/read_portfolio/)).toBeInTheDocument();
    expect(screen.getByText(/1 bot/)).toBeInTheDocument();
    expect(screen.getByText(/created bot abc/)).toBeInTheDocument();
    expect(screen.getByText(/guardrail tripped/)).toBeInTheDocument();

    const links = screen.getAllByRole('link');
    const decisionLinks = links.filter((l) => l.getAttribute('href')?.includes('focus=dec-'));
    expect(decisionLinks).toHaveLength(2);
    expect(decisionLinks[0]).toHaveAttribute('href', '/dashboard/ai-pm/activity?focus=dec-1');
    expect(decisionLinks[1]).toHaveAttribute('href', '/dashboard/ai-pm/activity?focus=dec-2');
  });

  it('does not render header when toolCalls is empty or missing', () => {
    render(wrap(
      <MessageBubble
        role="assistant"
        content="hi"
        decisionId={null}
        toolCalls={[]}
        createdAt="2026-05-12T00:00:00Z"
      />,
    ));
    expect(screen.queryByText('Actions')).not.toBeInTheDocument();
  });

  it('renders bold/italic/code inline markdown in assistant content', () => {
    const { container } = render(wrap(
      <MessageBubble
        role="assistant"
        content="Result is **important** and *fast* with `code`."
        decisionId={null}
        toolCalls={null}
        createdAt="2026-05-12T00:00:00Z"
      />,
    ));
    const strong = container.querySelector('strong');
    const em = container.querySelector('em');
    const code = container.querySelector('code');
    expect(strong?.textContent).toBe('important');
    expect(em?.textContent).toBe('fast');
    expect(code?.textContent).toBe('code');
    expect(container.textContent).not.toMatch(/\*\*important\*\*/);
  });

  it('failed user message renders a retry button when onRetry is provided', () => {
    const onRetry = vi.fn();
    render(wrap(
      <MessageBubble
        role="user"
        content="ping"
        decisionId={null}
        toolCalls={null}
        createdAt="2026-05-12T00:00:00Z"
        failed
        onRetry={onRetry}
      />,
    ));
    const btn = screen.getByRole('button', { name: /Couldn't send/i });
    fireEvent.click(btn);
    expect(onRetry).toHaveBeenCalledOnce();
  });

  it('pending typing indicator places dots and label inside the bubble container', () => {
    const { container } = render(wrap(
      <MessageBubble
        role="assistant"
        content=""
        decisionId={null}
        toolCalls={null}
        createdAt="2026-05-12T00:00:00Z"
        pending
      />,
    ));
    // Bubble container is the inner div with rounded-2xl. Typing label must
    // be a descendant of it (not a sibling that visually overflows).
    const bubble = container.querySelector('.rounded-2xl');
    expect(bubble).toBeTruthy();
    expect(bubble?.textContent).toContain('Thinking...');
  });
});
