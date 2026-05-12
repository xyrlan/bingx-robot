// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
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
});
