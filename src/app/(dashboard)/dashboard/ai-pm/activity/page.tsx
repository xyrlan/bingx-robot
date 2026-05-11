import { requireAuth } from '@/services/auth.service';
import { getTranslations } from 'next-intl/server';
import { ActivityClient } from '@/components/ai-pm/activity/ActivityClient';

export default async function AiPmActivityPage() {
  await requireAuth();
  const t = await getTranslations('AiPm.Activity');
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">{t('title')}</h1>
        <p className="text-sm text-muted mt-1">{t('subtitle')}</p>
      </div>
      <ActivityClient />
    </div>
  );
}
