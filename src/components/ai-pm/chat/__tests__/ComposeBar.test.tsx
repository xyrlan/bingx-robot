// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { ComposeBar } from '../ComposeBar';

const messages = {
  AiPm: {
    Chat: {
      placeholder: 'Ask the portfolio manager...',
      send: 'Send',
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

describe('ComposeBar', () => {
  it('renders placeholder and send button', () => {
    render(wrap(<ComposeBar onSend={() => {}} disabled={false} />));
    expect(screen.getByPlaceholderText('Ask the portfolio manager...')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /send/i })).toBeInTheDocument();
  });

  it('calls onSend with text when Enter pressed', () => {
    const onSend = vi.fn();
    render(wrap(<ComposeBar onSend={onSend} disabled={false} />));
    const ta = screen.getByPlaceholderText('Ask the portfolio manager...') as HTMLTextAreaElement;
    fireEvent.change(ta, { target: { value: 'hello' } });
    fireEvent.keyDown(ta, { key: 'Enter', shiftKey: false });
    expect(onSend).toHaveBeenCalledWith('hello');
  });

  it('does not call onSend on Shift+Enter', () => {
    const onSend = vi.fn();
    render(wrap(<ComposeBar onSend={onSend} disabled={false} />));
    const ta = screen.getByPlaceholderText('Ask the portfolio manager...') as HTMLTextAreaElement;
    fireEvent.change(ta, { target: { value: 'hello' } });
    fireEvent.keyDown(ta, { key: 'Enter', shiftKey: true });
    expect(onSend).not.toHaveBeenCalled();
  });

  it('does not call onSend with empty text', () => {
    const onSend = vi.fn();
    render(wrap(<ComposeBar onSend={onSend} disabled={false} />));
    const ta = screen.getByPlaceholderText('Ask the portfolio manager...') as HTMLTextAreaElement;
    fireEvent.change(ta, { target: { value: '   ' } });
    fireEvent.keyDown(ta, { key: 'Enter', shiftKey: false });
    expect(onSend).not.toHaveBeenCalled();
  });

  it('disabled state prevents send', () => {
    const onSend = vi.fn();
    render(wrap(<ComposeBar onSend={onSend} disabled={true} />));
    const ta = screen.getByPlaceholderText('Ask the portfolio manager...') as HTMLTextAreaElement;
    fireEvent.change(ta, { target: { value: 'hi' } });
    fireEvent.keyDown(ta, { key: 'Enter', shiftKey: false });
    expect(onSend).not.toHaveBeenCalled();
  });

  it('caps input at 2000 chars', () => {
    render(wrap(<ComposeBar onSend={() => {}} disabled={false} />));
    const ta = screen.getByPlaceholderText('Ask the portfolio manager...') as HTMLTextAreaElement;
    expect(ta.maxLength).toBe(2000);
  });

  it('clears textarea after successful send', () => {
    const onSend = vi.fn();
    render(wrap(<ComposeBar onSend={onSend} disabled={false} />));
    const ta = screen.getByPlaceholderText('Ask the portfolio manager...') as HTMLTextAreaElement;
    fireEvent.change(ta, { target: { value: 'msg' } });
    fireEvent.keyDown(ta, { key: 'Enter', shiftKey: false });
    expect(ta.value).toBe('');
  });
});
