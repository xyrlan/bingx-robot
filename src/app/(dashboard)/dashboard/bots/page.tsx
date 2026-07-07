import { getTranslations } from 'next-intl/server';
import { BotTypeSelector } from '@/components/trading/bot-type-selector';
import { BotsList } from '@/components/trading/bots-list';
import { Accordion } from '@heroui/react';

export default async function BotsPage() {
  const t = await getTranslations('Bots');

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold text-foreground">{t('title')}</h1>

      <Accordion>
        <Accordion.Item id="create">
          <Accordion.Heading>
            <Accordion.Trigger className="text-base font-semibold">
              {t('createNew')}
            </Accordion.Trigger>
            <Accordion.Indicator />
          </Accordion.Heading>
          <Accordion.Panel>
            <Accordion.Body className="pt-4">
              <BotTypeSelector />
            </Accordion.Body>
          </Accordion.Panel>
        </Accordion.Item>
      </Accordion>

      <BotsList />
    </div>
  );
}
