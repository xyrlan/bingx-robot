import { BotConfigForm } from '@/components/trading/bot-config-form';
import { BotsList } from '@/components/trading/bots-list';

export default function BotsPage() {
  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold text-foreground">Bots</h1>
      <BotConfigForm />
      <BotsList />
    </div>
  );
}
