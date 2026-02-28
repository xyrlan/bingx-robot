'use client';

import { useEffect, useState } from 'react';
import { Card, Button } from '@heroui/react';

type Bot = {
  id: string;
  symbol: string;
  priceMin: string;
  priceMax: string;
  gridCount: number;
  status: 'STOPPED' | 'RUNNING';
  createdAt: string;
};

export function BotsList() {
  const [bots, setBots] = useState<Bot[]>([]);
  const [loading, setLoading] = useState(false);

  async function fetchBots() {
    setLoading(true);
    try {
      const res = await fetch('/api/bingx/bot');
      const data = await res.json();
      if (res.ok) {
        setBots(data.bots ?? []);
      }
    } finally {
      setLoading(false);
    }
  }

  async function handleStop(botId: string) {
    try {
      const res = await fetch('/api/bingx/bot/stop', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ botId }),
      });
      if (res.ok) {
        fetchBots();
      }
    } catch {
      // ignore
    }
  }

  useEffect(() => {
    fetchBots();
  }, []);

  if (bots.length === 0) {
    return null;
  }

  return (
    <Card variant="default" className="w-full">
      <Card.Content className="p-6">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-lg font-semibold">Your Bots</h3>
          <Button size="sm" variant="outline" onPress={fetchBots} isDisabled={loading}>
            Refresh
          </Button>
        </div>
        <div className="space-y-3">
          {bots.map((bot) => (
            <div
              key={bot.id}
              className="flex items-center justify-between p-3 rounded-lg bg-default-100"
            >
              <div>
                <p className="font-medium">{bot.symbol}</p>
                <p className="text-sm text-default-500">
                  {bot.priceMin} – {bot.priceMax} • {bot.gridCount ?? 1} grids • {bot.status}
                </p>
              </div>
              {bot.status === 'RUNNING' && (
                <Button
                  size="sm"
                  variant="outline"
                  onPress={() => handleStop(bot.id)}
                >
                  Stop
                </Button>
              )}
            </div>
          ))}
        </div>
      </Card.Content>
    </Card>
  );
}
