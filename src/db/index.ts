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
