import { BotTypeSelector } from '@/components/trading/bot-type-selector';
import { BotsList } from '@/components/trading/bots-list';

export default function BotsPage() {
  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold text-foreground">Bots</h1>
      <BotTypeSelector />
      <BotsList />
    </div>
  );
}
