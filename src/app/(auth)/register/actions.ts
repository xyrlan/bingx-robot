'use server';

import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { registrationSchema } from '../schemas';
import { ensureUserSetup } from '@/services/user-setup.service';

export interface RegistrationState {
  error?: string;
  success?: boolean;
}

/**
 * Generic registration server action.
 * Creates Supabase Auth user and ensures user + profile are created.
 */
export async function registerAction(
  prevState: RegistrationState | null,
  formData: FormData
): Promise<RegistrationState> {
  try {
    const rawData = {
      fullName: formData.get('fullName') as string,
      email: formData.get('email') as string,
      password: formData.get('password') as string,
    };

    const validatedData = registrationSchema.parse(rawData);

    const supabase = await createClient();

    const { data, error } = await supabase.auth.signUp({
      email: validatedData.email,
      password: validatedData.password,
      options: {
        data: {
          fullName: validatedData.fullName,
        },
        emailRedirectTo: `${process.env.NEXT_PUBLIC_SITE_URL || 'http://localhost:3000'}/api/auth/callback`,
      },
    });

    if (error) {
      if (error.message.includes('already registered') || error.message.includes('already exists')) {
        return { error: 'This email is already registered' };
      }
      if (error.message.includes('password')) {
        return { error: 'Password must be at least 8 characters' };
      }
      return { error: error.message };
    }

    if (!data.user) {
      return { error: 'Failed to create account. Please try again.' };
    }

    const setupResult = await ensureUserSetup(data.user.id, validatedData.email, {
      fullName: validatedData.fullName,
    });

    if (!setupResult.success) {
      console.error('User setup failed:', setupResult.error);
    }

    redirect(`/verify-email?email=${encodeURIComponent(validatedData.email)}`);
  } catch (error) {
    if (error && typeof error === 'object' && 'issues' in error) {
      const zodError = error as { issues: Array<{ message: string }> };
      return { error: zodError.issues[0]?.message || 'Invalid data' };
    }

    if (error && typeof error === 'object' && 'digest' in error) {
      throw error;
    }

    return { error: 'An error occurred. Please try again.' };
  }
}
