'use server';

import { db } from '@/db';
import { users, profiles } from '@/db/schema';

export interface UserSetupInput {
  fullName?: string;
}

export interface UserSetupResult {
  success: boolean;
  error?: string;
}

/**
 * Create user and profile records after Supabase Auth signup.
 * Called as fallback when database trigger is disabled or fails.
 */
export async function ensureUserSetup(
  userId: string,
  email: string,
  input: UserSetupInput
): Promise<UserSetupResult> {
  try {
    const emailVerifiedAt = null;

    await db
      .insert(users)
      .values({
        id: userId,
        email,
        emailVerifiedAt: emailVerifiedAt,
      })
      .onConflictDoNothing();

    await db
      .insert(profiles)
      .values({
        id: userId,
        userId,
        fullName: input.fullName ?? null,
      })
      .onConflictDoNothing();

    return { success: true };
  } catch (error) {
    console.error('User setup failed:', error);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}
