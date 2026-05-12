import { NextResponse } from 'next/server';
import { z } from 'zod';
import { db } from '@/db';
import { aiChatMessages, aiPmConfigs } from '@/db/schema';
import { and, eq } from 'drizzle-orm';
import { inngest } from '@/inngest/client';
import { getAuthenticatedUser } from '@/services/auth.service';
import { truncateChatMessage } from '@/lib/ai-pm/events';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const BodySchema = z.object({
  configId: z.string().regex(UUID_RE, 'Invalid UUID'),
  message: z.string().min(1).max(2000),
});

export async function POST(req: Request): Promise<NextResponse> {
  const user = await getAuthenticatedUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  let body: z.infer<typeof BodySchema>;
  try {
    const parsed = BodySchema.safeParse(await req.json());
    if (!parsed.success) return NextResponse.json({ error: 'Invalid body', issues: parsed.error.issues }, { status: 400 });
    body = parsed.data;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const config = await db.query.aiPmConfigs.findFirst({
    where: and(eq(aiPmConfigs.id, body.configId), eq(aiPmConfigs.userId, user.id)),
  });
  if (!config) return NextResponse.json({ error: 'Config not found' }, { status: 404 });

  const truncated = truncateChatMessage(body.message);
  const [row] = await db
    .insert(aiChatMessages)
    .values({ userId: user.id, role: 'user', content: truncated })
    .returning();

  const [assistantPlaceholder] = await db
    .insert(aiChatMessages)
    .values({ userId: user.id, role: 'assistant', content: '', toolCalls: [], decisionId: null })
    .returning();

  await inngest.send({
    name: 'ai-pm/event.chat',
    data: {
      configId: body.configId,
      emittedAt: new Date().toISOString(),
      symbol: null,
      chatMessageId: row.id,
      userMessage: truncated,
      assistantPlaceholderId: assistantPlaceholder.id,
    },
  });

  return NextResponse.json({ ok: true, chatMessageId: row.id, placeholderId: assistantPlaceholder.id });
}
