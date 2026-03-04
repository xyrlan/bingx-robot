'use client';

import { useState, useEffect } from 'react';
import { Card, TextField, Input, Label, Button, toast } from '@heroui/react';

export function ConnectKeysForm() {
  const [connected, setConnected] = useState<boolean | null>(null);
  const [editing, setEditing] = useState(false);
  const [apiKey, setApiKey] = useState('');
  const [secretKey, setSecretKey] = useState('');
  const [loading, setLoading] = useState(false);

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
    try {
      const res = await fetch('/api/bingx/keys', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ apiKey, secretKey }),
      });
      const data = await res.json();
      if (!res.ok) {
        toast.danger(data.error ?? 'Failed to save keys');
        return;
      }
      toast.success('Keys saved successfully');
      setApiKey('');
      setSecretKey('');
      setConnected(true);
      setEditing(false);
    } catch {
      toast.danger('Network error');
    } finally {
      setLoading(false);
    }
  }

  async function handleDisconnect() {
    setLoading(true);
    try {
      const res = await fetch('/api/bingx/keys', { method: 'DELETE' });
      if (!res.ok) {
        const data = await res.json();
        toast.danger(data.error ?? 'Failed to disconnect');
        return;
      }
      toast.success('Keys removed. Connect again to use.');
      setConnected(false);
      setEditing(true);
    } catch {
      toast.danger('Network error');
    } finally {
      setLoading(false);
    }
  }

  const showForm = !connected || editing;

  return (
    <Card variant="default" className="w-full">
      <Card.Content className="p-6">
        <h3 className="text-lg font-semibold mb-4">BingX Connection</h3>
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
                  onPress={() => setEditing(false)}
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
