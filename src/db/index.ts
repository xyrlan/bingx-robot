import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema';
import { validateEnv } from '@/lib/env';

validateEnv();

const connectionString = process.env.DATABASE_URL!;

// Raw postgres client. Multiplexed for normal query traffic and also exposed
// for streaming/NOTIFY-LISTEN usage in the chat streaming module.
export const sql = postgres(connectionString, { prepare: false });
export const db = drizzle(sql, { schema });
