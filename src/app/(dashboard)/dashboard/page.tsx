import { createClient } from '@/lib/supabase/server';
import { Button } from '@heroui/react';
import Link from 'next/link';
import { signOutAction } from './actions';
import { ConnectKeysForm } from '@/components/trading/connect-keys-form';
import { BalanceDisplay } from '@/components/trading/balance-display';
import { BotConfigForm } from '@/components/trading/bot-config-form';
import { BotsList } from '@/components/trading/bots-list';

export default async function DashboardPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return null;
  }

  return (
    <div className="min-h-screen p-6 sm:p-8">
      <div className="max-w-4xl mx-auto space-y-6">
        <header className="flex items-center justify-between">
          <h1 className="text-2xl font-bold text-foreground">Dashboard</h1>
          <form action={signOutAction}>
            <Button type="submit" variant="outline">
              Sign out
            </Button>
          </form>
        </header>

        <section>
          <h2 className="text-lg font-semibold mb-4">Trading Bot</h2>
          <div className="space-y-6">
              <ConnectKeysForm />
              <BalanceDisplay />
            <BotConfigForm />
            <BotsList />
          </div>
        </section>

        <footer>
          <Link href="/" className="text-sm text-default-500 hover:text-foreground transition-colors">
            Back to home
          </Link>
        </footer>
      </div>
    </div>
  );
}
