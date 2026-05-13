import { redirect } from 'next/navigation';
import { getAuthenticatedUser } from '@/services/auth.service';
import { loadChatHistoryAsUIMessages } from '@/services/ai-pm-chat-history.service';
import { listAiPmConfigsForUser } from '@/services/ai-pm-config.service';
import { ChatClient } from '@/components/ai-pm/chat/ChatClient';

export const dynamic = 'force-dynamic';

export default async function ChatPage() {
  const user = await getAuthenticatedUser();
  if (!user) redirect('/login');

  const [initialMessages, configs] = await Promise.all([
    loadChatHistoryAsUIMessages(user.id, 30),
    listAiPmConfigsForUser(user.id),
  ]);

  // Only show subaccounts where AI is enabled. Disabled ones can't chat;
  // hiding them from the picker avoids "AI is not enabled" surprises.
  const configOptions = configs
    .filter((c) => c.enabled)
    .map((c) => ({
      id: c.id,
      label: c.bingxApiKeyId.slice(0, 8),
      enabled: c.enabled,
      killSwitch: c.killSwitch,
      paperMode: c.paperMode,
    }));

  return (
    <div className="h-[calc(100vh-4rem)] md:h-screen flex flex-col">
      <ChatClient configs={configOptions} initialMessages={initialMessages} />
    </div>
  );
}
