'use client';

import { useState } from 'react';
import { Card, TextField, Input, Label, Button, toast, Spinner } from '@heroui/react';
import { useActiveAccount } from '@/contexts/active-account';
import { useTranslations } from 'next-intl';

export function ConnectKeysForm() {
  const t = useTranslations('Accounts');
  const { accounts, activeAccountId, refreshAccounts } = useActiveAccount();
  const [showAddForm, setShowAddForm] = useState(false);
  const [label, setLabel] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [secretKey, setSecretKey] = useState('');
  const [saving, setSaving] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  async function handleAdd(e: React.FormEvent) {
    e.preventDefault();
    if (!apiKey.trim() || !secretKey.trim()) {
      toast.danger('API Key and Secret Key are required');
      return;
    }
    setSaving(true);
    try {
      const res = await fetch('/api/bingx/keys', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          apiKey: apiKey.trim(),
          secretKey: secretKey.trim(),
          label: label.trim() || 'Main',
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        toast.danger(data.error ?? 'Failed to save keys');
        return;
      }
      toast.success('Account added successfully');
      setApiKey('');
      setSecretKey('');
      setLabel('');
      setShowAddForm(false);
      await refreshAccounts();
    } catch {
      toast.danger('Network error');
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(apiKeyId: string) {
    if (!window.confirm(t('confirmDelete'))) return;
    setDeletingId(apiKeyId);
    try {
      const res = await fetch('/api/bingx/keys', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ apiKeyId }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        toast.danger(data.error ?? 'Failed to delete account');
        return;
      }
      toast.success('Account deleted');
      await refreshAccounts();
    } catch {
      toast.danger('Network error');
    } finally {
      setDeletingId(null);
    }
  }

  return (
    <div className="space-y-4">
      {/* Header with Add button */}
      <div className="flex items-center justify-between">
        <h3 className="text-lg font-semibold">{t('title')}</h3>
        {!showAddForm && (
          <Button size="sm" variant="primary" onPress={() => setShowAddForm(true)}>
            {t('addAccount')}
          </Button>
        )}
      </div>

      {/* Add Account Form */}
      {showAddForm && (
        <Card variant="default" className="w-full">
          <Card.Content className="p-6">
            <h4 className="text-base font-semibold mb-4">{t('addAccount')}</h4>
            <form onSubmit={handleAdd} className="space-y-4">
              <TextField variant="primary" isDisabled={saving}>
                <Label>{t('label')}</Label>
                <Input
                  type="text"
                  value={label}
                  onChange={(e) => setLabel(e.target.value)}
                  placeholder="e.g. Main, Sub 1, Trading..."
                  autoComplete="off"
                />
              </TextField>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <TextField variant="primary" isDisabled={saving}>
                  <Label>{t('apiKey')}</Label>
                  <Input
                    type="text"
                    value={apiKey}
                    onChange={(e) => setApiKey(e.target.value)}
                    placeholder="Your BingX API Key"
                    autoComplete="off"
                  />
                </TextField>
                <TextField variant="primary" isDisabled={saving}>
                  <Label>{t('secretKey')}</Label>
                  <Input
                    type="password"
                    value={secretKey}
                    onChange={(e) => setSecretKey(e.target.value)}
                    placeholder="Your BingX Secret Key"
                    autoComplete="off"
                  />
                </TextField>
              </div>
              <div className="flex gap-2">
                <Button type="submit" variant="primary" isDisabled={saving}>
                  {saving ? <Spinner size="sm" /> : t('addAccount')}
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  onPress={() => {
                    setShowAddForm(false);
                    setApiKey('');
                    setSecretKey('');
                    setLabel('');
                  }}
                  isDisabled={saving}
                >
                  Cancel
                </Button>
              </div>
            </form>
          </Card.Content>
        </Card>
      )}

      {/* Accounts List */}
      {accounts.length === 0 ? (
        <Card variant="default" className="w-full">
          <Card.Content className="p-6">
            <p className="text-sm text-muted text-center py-4">
              No accounts connected yet. Add your first BingX API key to get started.
            </p>
          </Card.Content>
        </Card>
      ) : (
        <div className="space-y-3">
          {accounts.map((acc) => {
            const isActive = acc.id === activeAccountId;
            return (
              <Card
                key={acc.id}
                variant="default"
                className={`w-full transition-colors ${
                  isActive ? 'border-accent/50 bg-accent/5' : ''
                }`}
              >
                <Card.Content className="px-4 py-5">
                  <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
                    <div>
                      <p className="font-medium text-sm">
                        {acc.label}
                        {isActive && (
                          <span className="ml-2 text-xs px-2 py-0.5 rounded-full bg-accent/10 text-accent">
                            Active
                          </span>
                        )}
                      </p>
                      <p className="text-xs text-muted">
                        {t('connected')}
                      </p>
                    </div>
                    <Button
                      size="sm"
                      variant="outline"
                      className="text-danger border-danger/50 hover:bg-danger/10 self-end sm:self-auto"
                      onPress={() => handleDelete(acc.id)}
                      isDisabled={deletingId === acc.id}
                    >
                      {deletingId === acc.id ? <Spinner size="sm" /> : t('deleteAccount')}
                    </Button>
                  </div>
                </Card.Content>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
