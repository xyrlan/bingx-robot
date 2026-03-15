import { BotTypeSelector } from '@/components/trading/bot-type-selector';
import { BotsList } from '@/components/trading/bots-list';
import { Accordion } from '@heroui/react';

export default function BotsPage() {
  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold text-foreground">Bots</h1>

      <Accordion>
        <Accordion.Item id="create">
          <Accordion.Heading>
            <Accordion.Trigger className="text-base font-semibold">
              Create New Bot
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
