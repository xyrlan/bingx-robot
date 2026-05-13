import { redirect } from 'next/navigation';
import { getAuthenticatedUser } from '@/services/auth.service';
import { listChatMessages } from '@/services/ai-pm-chat-history.service';
import { listAiPmConfigsForUser } from '@/services/ai-pm-config.service';
import { ChatClient } from '@/components/ai-pm/chat/ChatClient';

export const dynamic = 'force-dynamic';

export default async function ChatPage() {
  const user = await getAuthenticatedUser();
  if (!user) redirect('/login');

  const [history, configs] = await Promise.all([
    listChatMessages(user.id, { limit: 30 }),
    listAiPmConfigsForUser(user.id),
  ]);

  // Only show subaccounts where AI is enabled. Disabled ones can't chat
  // (chat-pipeline rejects with a canned reply); hiding them from the picker
  // avoids the user wondering why their messages get "AI is not enabled" replies.
  const configOptions = configs
    .filter((c) => c.enabled)
    .map((c) => ({
      id: c.id,
      label: c.bingxApiKeyId.slice(0, 8),
      enabled: c.enabled,
      killSwitch: c.killSwitch,
      paperMode: c.paperMode,
    }));

  // Service returns DESC (newest first); ChatClient expects ASC for display.
  const initialMessagesAsc = history.messages.slice().reverse();

  return (
    <div className="h-[calc(100vh-4rem)] md:h-screen flex flex-col">
      <ChatClient
        configs={configOptions}
        initialMessages={initialMessagesAsc}
        initialOldestCursor={history.nextCursor}
      />
    </div>
  );
}
