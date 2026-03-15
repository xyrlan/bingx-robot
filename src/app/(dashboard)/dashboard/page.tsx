import { OverviewStats } from '@/components/dashboard/overview-stats';
import { ActiveBotsSummary } from '@/components/dashboard/active-bots-summary';

export default function DashboardPage() {
  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold text-foreground">Overview</h1>
      <OverviewStats />
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <ActiveBotsSummary />
      </div>
    </div>
  );
}
