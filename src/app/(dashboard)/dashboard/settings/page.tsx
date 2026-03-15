import { SymbolLeverageCard } from '@/components/trading/symbol-leverage-card';

export default function SettingsPage() {
  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold text-foreground">Settings</h1>
      <SymbolLeverageCard />
    </div>
  );
}
