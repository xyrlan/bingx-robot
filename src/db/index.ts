import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema';
import { validateEnv } from '@/lib/env';

validateEnv();

// O Supabase fornece a string de conexão no painel (Transaction Pooler recomendado)
const connectionString = process.env.DATABASE_URL!;

// Para queries em tempo real (Next.js Server Components)
const client = postgres(connectionString, { prepare: false });
export const db = drizzle(client, { schema });