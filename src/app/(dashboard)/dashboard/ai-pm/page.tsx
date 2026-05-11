import { requireAuth } from '@/services/auth.service';
import { getUserApiKeys } from '@/services/bingx.service';
import { AiPmSettingsClient } from '@/components/ai-pm/AiPmSettingsClient';
import { getTranslations } from 'next-intl/server';

export default async function AiPmPage() {
  const user = await requireAuth();
  const subaccounts = await getUserApiKeys(user.id);
  const t = await getTranslations('AiPm.Settings');
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">{t('title')}</h1>
        <p className="text-sm text-muted mt-1">{t('subtitle')}</p>
      </div>
      <AiPmSettingsClient subaccounts={subaccounts} />
    </div>
  );
}
