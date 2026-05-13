// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import type { UIMessage } from 'ai';
import { ChatClient } from '../ChatClient';

// Stub the useChat hook so tests don't depend on a real transport. We assert
// rendering against the mocked messages array.
let mockMessages: UIMessage[] = [];
const sendMessageMock = vi.fn();
const stopMock = vi.fn();
const clearErrorMock = vi.fn();

vi.mock('@ai-sdk/react', () => ({
  useChat: () => ({
    messages: mockMessages,
    sendMessage: sendMessageMock,
    status: 'ready' as const,
    error: undefined,
    stop: stopMock,
    clearError: clearErrorMock,
  }),
}));

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
      sendFailed: "Couldn't send.",
      noResponse: 'No response.',
      sessionExpired: 'Session expired',
      noConfigsCta: 'Set up first',
      typing: 'Thinking...',
      viewDecision: 'View decision',
      you: 'You',
      assistant: 'AI',
      toolCallsHeader: 'Actions',
      toolStatus: { executed: 'executed', rejected: 'rejected', failed: 'failed', executing: 'executing...' },
      budgetExhausted: '',
      maxTurnsHit: '',
      killSwitchMidLoop: 'Stop',
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
  it('renders initial messages with text + tool parts', () => {
    mockMessages = [
      {
        id: 'm1',
        role: 'user',
        parts: [{ type: 'text', text: 'hi' }],
      } as UIMessage,
      {
        id: 'm2',
        role: 'assistant',
        parts: [
          { type: 'text', text: 'hello world' },
          {
            type: 'tool-read_portfolio',
            toolCallId: 'tc-1',
            state: 'output-available',
            input: {},
            output: { status: 'EXECUTED', summary: '0 bots running, $0 used', decisionId: null },
          } as unknown as UIMessage['parts'][number],
        ],
      } as UIMessage,
    ];

    render(wrap(<ChatClient configs={[CONFIG]} initialMessages={mockMessages} />));
    expect(screen.getByText('hi')).toBeInTheDocument();
    expect(screen.getByText('hello world')).toBeInTheDocument();
    expect(screen.getByText('read_portfolio')).toBeInTheDocument();
    expect(screen.getByText(/0 bots running/)).toBeInTheDocument();
  });

  it('shows noConfigsCta when there are no configs', () => {
    mockMessages = [];
    render(wrap(<ChatClient configs={[]} initialMessages={[]} />));
    expect(screen.getByText('Set up first')).toBeInTheDocument();
  });
});
