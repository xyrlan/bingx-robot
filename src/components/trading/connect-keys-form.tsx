'use client';

import { useState } from 'react';
import { Card, TextField, Input, Label, Button } from '@heroui/react';

export function ConnectKeysForm() {
  const [apiKey, setApiKey] = useState('');
  const [secretKey, setSecretKey] = useState('');
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setMessage(null);
    try {
      const res = await fetch('/api/bingx/keys', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ apiKey, secretKey }),
      });
      const data = await res.json();
      if (!res.ok) {
        setMessage({ type: 'error', text: data.error ?? 'Failed to save keys' });
        return;
      }
      setMessage({ type: 'success', text: 'BingX API keys saved successfully' });
      setApiKey('');
      setSecretKey('');
    } catch {
      setMessage({ type: 'error', text: 'Network error' });
    } finally {
      setLoading(false);
    }
  }

  return (
    <Card variant="default" className="w-full">
      <Card.Content className="p-6">
        <h3 className="text-lg font-semibold mb-4">Connect BingX API</h3>
        <form onSubmit={handleSubmit} className="space-y-4">
          {message && (
            <div
              className={`p-3 rounded-lg text-sm ${
                message.type === 'success'
                  ? 'bg-success/10 border border-success/30 text-success'
                  : 'bg-danger/10 border border-danger/30 text-danger'
              }`}
            >
              {message.text}
            </div>
          )}
          <TextField variant="primary" isDisabled={loading}>
            <Label>API Key</Label>
            <Input
              name="apiKey"
              type="text"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder="Your BingX API Key"
              autoComplete="off"
            />
          </TextField>
          <TextField variant="primary" isDisabled={loading}>
            <Label>Secret Key</Label>
            <Input
              name="secretKey"
              type="password"
              value={secretKey}
              onChange={(e) => setSecretKey(e.target.value)}
              placeholder="Your BingX Secret Key"
              autoComplete="off"
            />
          </TextField>
          <Button type="submit" variant="primary" isDisabled={loading}>
            {loading ? 'Saving...' : 'Save Keys'}
          </Button>
        </form>
      </Card.Content>
    </Card>
  );
}
