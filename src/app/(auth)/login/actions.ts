'use server';

import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { loginSchema } from '@/app/(auth)/schemas';

export interface LoginState {
  error?: string;
  success?: boolean;
}

/**
 * Login server action.
 * Validates credentials and signs in with Supabase Auth.
 * Redirects to /dashboard on success.
 */
export async function loginAction(
  prevState: LoginState | null,
  formData: FormData
): Promise<LoginState> {
  try {
    const rawData = {
      email: formData.get('email') as string,
      password: formData.get('password') as string,
    };

    const validatedData = loginSchema.parse(rawData);

    const supabase = await createClient();

    const { data, error } = await supabase.auth.signInWithPassword({
      email: validatedData.email,
      password: validatedData.password,
    });

    if (error) {
      if (error.message.includes('Invalid login credentials')) {
        return { error: 'Invalid email or password' };
      }
      if (error.message.includes('Email not confirmed')) {
        return { error: 'Please confirm your email before signing in' };
      }
      return { error: error.message };
    }

    if (!data.user) {
      return { error: 'Sign in failed. Please try again.' };
    }

    redirect('/dashboard');
  } catch (error) {
    if (error && typeof error === 'object' && 'digest' in error) {
      throw error;
    }

    if (error && typeof error === 'object' && 'issues' in error) {
      const zodError = error as { issues: Array<{ message: string }> };
      return { error: zodError.issues[0]?.message || 'Invalid data' };
    }

    return { error: 'An error occurred. Please try again.' };
  }
}
