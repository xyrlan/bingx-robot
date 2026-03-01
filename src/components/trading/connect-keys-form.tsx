'use client';

import { useState, useEffect } from 'react';
import { Card, TextField, Input, Label, Button } from '@heroui/react';

export function ConnectKeysForm() {
  const [connected, setConnected] = useState<boolean | null>(null);
  const [editing, setEditing] = useState(false);
  const [apiKey, setApiKey] = useState('');
  const [secretKey, setSecretKey] = useState('');
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  async function fetchConnectionStatus() {
    try {
      const res = await fetch('/api/bingx/keys');
      const data = await res.json();
      setConnected(res.ok && data.connected === true);
    } catch {
      setConnected(false);
    }
  }

  useEffect(() => {
    fetchConnectionStatus();
  }, []);

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
      setMessage({ type: 'success', text: 'Keys saved successfully' });
      setApiKey('');
      setSecretKey('');
      setConnected(true);
      setEditing(false);
    } catch {
      setMessage({ type: 'error', text: 'Network error' });
    } finally {
      setLoading(false);
    }
  }

  async function handleDisconnect() {
    setLoading(true);
    setMessage(null);
    try {
      const res = await fetch('/api/bingx/keys', { method: 'DELETE' });
      if (!res.ok) {
        const data = await res.json();
        setMessage({ type: 'error', text: data.error ?? 'Failed to disconnect' });
        return;
      }
      setConnected(false);
      setEditing(true);
      setMessage({ type: 'success', text: 'Keys removed. Connect again to use.' });
    } catch {
      setMessage({ type: 'error', text: 'Network error' });
    } finally {
      setLoading(false);
    }
  }

  const showForm = !connected || editing;

  return (
    <Card variant="default" className="w-full">
      <Card.Content className="p-6">
        <h3 className="text-lg font-semibold mb-4">BingX Connection</h3>
        {message && (
          <div
            className={`mb-4 p-3 rounded-lg text-sm ${
              message.type === 'success'
                ? 'bg-success/10 border border-success/30 text-success'
                : 'bg-danger/10 border border-danger/30 text-danger'
            }`}
          >
            {message.text}
          </div>
        )}
        {connected === null ? (
          <p className="text-default-500 text-sm">Loading...</p>
        ) : connected && !showForm ? (
          <div className="space-y-4">
            <div className="flex items-center gap-2 p-3 rounded-lg bg-success/10 border border-success/30">
              <span className="text-success font-medium">BingX account connected</span>
            </div>
            <div className="flex gap-2">
              <Button
                variant="outline"
                onPress={() => setEditing(true)}
                isDisabled={loading}
              >
                Edit keys
              </Button>
              <Button
                variant="outline"
                className="text-danger border-danger/50 hover:bg-danger/10"
                onPress={handleDisconnect}
                isDisabled={loading}
              >
                {loading ? 'Disconnecting...' : 'Disconnect'}
              </Button>
            </div>
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="space-y-4">
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
            <div className="flex gap-2">
              <Button type="submit" variant="primary" isDisabled={loading}>
                {loading ? 'Saving...' : 'Save keys'}
              </Button>
              {connected && (
                <Button
                  type="button"
                  variant="outline"
                  onPress={() => {
                    setEditing(false);
                    setMessage(null);
                  }}
                  isDisabled={loading}
                >
                  Cancel
                </Button>
              )}
            </div>
          </form>
        )}
      </Card.Content>
    </Card>
  );
}
