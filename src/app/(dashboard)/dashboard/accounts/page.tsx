import { ConnectKeysForm } from '@/components/trading/connect-keys-form';
import { BalanceDisplay } from '@/components/trading/balance-display';

export default function AccountsPage() {
  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold text-foreground">Accounts</h1>
      <ConnectKeysForm />
      <BalanceDisplay />
    </div>
  );
}
