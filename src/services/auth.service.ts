import { createClient } from '@/lib/supabase/server';
import { db } from '@/db';
import { profiles } from '@/db/schema';
import { eq } from 'drizzle-orm';
import type { InferSelectModel } from 'drizzle-orm';

type Profile = InferSelectModel<typeof profiles>;

/**
 * Get the currently authenticated user from Supabase Auth
 * Returns user object or null if not authenticated
 */
export async function getAuthenticatedUser() {
  const supabase = await createClient();
  const { data: { user }, error } = await supabase.auth.getUser();

  if (error) {
    console.error('Error getting authenticated user:', error);
    return null;
  }

  return user;
}

/**
 * Require authentication - throws error if user is not authenticated
 * Use in Server Components that require a logged-in user
 * 
 * @throws Error if user is not authenticated
 * @returns Authenticated user object
 */
export async function requireAuth() {
  const user = await getAuthenticatedUser();

  if (!user) {
    throw new Error('Authentication required. User is not logged in.');
  }

  return user;
}

/**
 * Get user profile from database
 * Fetches complete profile data including relationships
 * 
 * @param userId - User UUID from Supabase Auth
 * @returns Profile object or null if not found
 */
export async function getUserProfile(userId: string): Promise<Profile | null> {
  try {
    const profile = await db.query.profiles.findFirst({
      where: eq(profiles.userId, userId),
    });

    return profile || null;
  } catch (error) {
    console.error('Error fetching user profile:', error);
    return null;
  }
}

/**
 * Get authenticated user with profile
 * Convenience function that combines auth check and profile fetch
 * 
 * @returns Object with user and profile, or null if not authenticated
 */
export async function getAuthenticatedUserWithProfile() {
  const user = await getAuthenticatedUser();

  if (!user) {
    return null;
  }

  const profile = await getUserProfile(user.id);

  return {
    user,
    profile,
  };
}

/**
 * Sign out the current user
 * Clears session and cookies
 */
export async function signOut() {
  const supabase = await createClient();
  const { error } = await supabase.auth.signOut();

  if (error) {
    console.error('Error signing out:', error);
    throw error;
  }

  return { success: true };
}
