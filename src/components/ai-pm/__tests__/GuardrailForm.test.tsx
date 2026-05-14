// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { GuardrailForm } from '../GuardrailForm';
import type { AiPmConfigPublic } from '../types';

vi.mock('@heroui/react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@heroui/react')>();
  return { ...actual, toast: { success: vi.fn(), danger: vi.fn() } };
});

const messages = {
  AiPm: {
    Settings: {
      modeConservative: 'Conservative',
      modeBalanced: 'Balanced',
      modeAggressive: 'Aggressive',
      lowRisk: 'Low risk',
      moderateRisk: 'Moderate risk',
      highRisk: 'High risk',
      maxCapital: 'Max capital (USDT)',
      maxBots: 'Max concurrent bots',
      allowedSymbols: 'Allowed symbols',
      allowedStrategies: 'Allowed strategies',
      symbolSearchPlaceholder: 'Search coins...',
      noSymbolsWarning: 'No symbols selected — the AI will not trade.',
      save: 'Save',
      cancel: 'Cancel',
      guardrailsSavedToast: 'Guardrails saved',
    },
  },
};

const baseConfig: AiPmConfigPublic = {
  id: 'cfg1',
  userId: 'u1',
  bingxApiKeyId: 'k1',
  enabled: true,
  mode: 'BALANCED',
  maxCapitalUsdt: '1000',
  maxConcurrentBots: 5,
  allowedSymbols: null,
  allowedStrategies: null,
  killSwitch: false,
  paperMode: false,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
};

function wrap(node: React.ReactNode) {
  return (
    <NextIntlClientProvider locale="en" messages={messages}>
      {node}
    </NextIntlClientProvider>
  );
}

function renderForm(config: AiPmConfigPublic | null = baseConfig, onSaved = vi.fn()) {
  render(wrap(<GuardrailForm config={config} configId="cfg1" onSaved={onSaved} />));
  return { onSaved };
}

beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ config: baseConfig }),
    }),
  );
});

describe('GuardrailForm — symbol picker', () => {
  it('always renders the custom config card with no show/hide toggle', () => {
    renderForm();
    expect(screen.getByLabelText('Max capital (USDT)')).toBeInTheDocument();
    expect(screen.queryByText(/show custom/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/hide custom/i)).not.toBeInTheDocument();
  });

  it('renders symbol checkboxes labelled with friendly names', () => {
    renderForm();
    expect(screen.getByRole('checkbox', { name: 'Bitcoin' })).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: 'Solana' })).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: 'Sui' })).toBeInTheDocument();
  });

  it('filters the symbol list via the search box', () => {
    renderForm();
    const search = screen.getByPlaceholderText('Search coins...');
    fireEvent.change(search, { target: { value: 'solana' } });
    expect(screen.getByRole('checkbox', { name: 'Solana' })).toBeInTheDocument();
    expect(screen.queryByRole('checkbox', { name: 'Bitcoin' })).not.toBeInTheDocument();
  });

  it('saves the symbol CODE (not the friendly name) when a coin is selected', async () => {
    const { onSaved } = renderForm();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Solana' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await vi.waitFor(() => expect(onSaved).toHaveBeenCalled());

    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body.allowedSymbols).toEqual(['SOL-USDT']);
  });

  it('shows a warning and saves null when no symbols are selected', async () => {
    const { onSaved } = renderForm(baseConfig);
    expect(screen.getByText(/the AI will not trade/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await vi.waitFor(() => expect(onSaved).toHaveBeenCalled());

    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body.allowedSymbols).toBeNull();
  });

  it('pre-selects symbols from existing config', () => {
    renderForm({ ...baseConfig, allowedSymbols: ['BTC-USDT'] });
    const btc = screen.getByRole('checkbox', { name: 'Bitcoin' });
    expect(btc).toBeChecked();
    const sol = screen.getByRole('checkbox', { name: 'Solana' });
    expect(sol).not.toBeChecked();
    // warning is gone once at least one symbol is selected
    expect(screen.queryByText(/the AI will not trade/i)).not.toBeInTheDocument();
    // sanity: scoped query helper import stays used
    expect(within(document.body).getByRole('button', { name: 'Save' })).toBeInTheDocument();
  });
});
