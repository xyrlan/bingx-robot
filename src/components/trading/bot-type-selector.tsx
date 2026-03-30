'use client';

import { useState } from 'react';
import { BotConfigForm } from './bot-config-form';
import { DCAConfigForm } from './dca-config-form';
import { GridShortConfigForm } from './grid-short-config-form';
import { TrailingStopConfigForm } from './trailing-stop-config-form';
import { DCASpotConfigForm } from './dca-spot-config-form';

type BotType = 'GRID_LONG' | 'GRID_SHORT' | 'DCA' | 'TRAILING_STOP' | 'DCA_SPOT';

const botTypes: { key: BotType; label: string; description: string }[] = [
  { key: 'GRID_LONG', label: 'Grid Long', description: 'Buy low, sell high in a range' },
  { key: 'GRID_SHORT', label: 'Grid Short', description: 'Short high, cover low in a range' },
  { key: 'DCA', label: 'DCA', description: 'Buy at regular intervals' },
  { key: 'TRAILING_STOP', label: 'Trailing Stop', description: 'Follow price, sell on reversal' },
  { key: 'DCA_SPOT', label: 'DCA Spot', description: 'DCA on spot market (no leverage)' },
];

export function BotTypeSelector() {
  const [selected, setSelected] = useState<BotType>('GRID_LONG');

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
        {botTypes.map((type) => (
          <button
            key={type.key}
            onClick={() => setSelected(type.key)}
            className={`p-3 sm:p-4 rounded-lg border text-left transition-colors touch-target ${
              selected === type.key
                ? 'border-accent bg-accent/10 text-accent'
                : 'border-default-200 hover:border-default-300 text-muted'
            }`}
          >
            <p className="text-sm font-medium">{type.label}</p>
            <p className="text-xs mt-1 text-muted leading-relaxed">{type.description}</p>
          </button>
        ))}
      </div>

      {selected === 'GRID_LONG' && <BotConfigForm />}
      {selected === 'GRID_SHORT' && <GridShortConfigForm />}
      {selected === 'DCA' && <DCAConfigForm />}
      {selected === 'TRAILING_STOP' && <TrailingStopConfigForm />}
      {selected === 'DCA_SPOT' && <DCASpotConfigForm />}
    </div>
  );
}
