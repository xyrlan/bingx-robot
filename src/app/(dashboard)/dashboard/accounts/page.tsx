import { ConnectKeysForm } from '@/components/trading/connect-keys-form';
import { BalanceDisplay } from '@/components/trading/balance-display';

export default function AccountsPage() {
  return (
    <div className="space-y-6">
      <ConnectKeysForm />
      <BalanceDisplay />
    </div>
  );
}
