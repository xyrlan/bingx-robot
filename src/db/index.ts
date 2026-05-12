import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema';
import { validateEnv } from '@/lib/env';

validateEnv();

const connectionString = process.env.DATABASE_URL!;

// Drizzle uses the pooled connection (Supabase transaction-mode pgbouncer on
// 6543 in production) for high-throughput query traffic.
const drizzleClient = postgres(connectionString, { prepare: false });
export const db = drizzle(drizzleClient, { schema });

// Dedicated client for streaming/NOTIFY-LISTEN. Postgres LISTEN requires a
// session-bound connection, which pgbouncer transaction-mode (port 6543)
// silently breaks. We prefer DIRECT_URL when it points at a non-pooler port;
// otherwise we coerce the DATABASE_URL port 6543 -> 5432 (Supabase session
// pooler) so listen subscriptions actually persist.
function resolveStreamingUrl(): string {
  const direct = process.env.DIRECT_URL;
  if (direct && !/:6543\//.test(direct)) return direct;
  return connectionString.replace(/:6543\//, ':5432/');
}

export const sql = postgres(resolveStreamingUrl(), { prepare: false, max: 4 });
