import { createClient } from '@/lib/supabase/server';
import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

/**
 * Auth Callback Route
 * Handles PKCE code exchange after email confirmation
 * Establishes session and redirects user to appropriate page
 */
export async function GET(request: NextRequest) {
  const requestUrl = new URL(request.url);
  const code = requestUrl.searchParams.get('code');
  const origin = requestUrl.origin;

  if (code) {
    const supabase = await createClient();
    
    // Exchange code for session
    const { error } = await supabase.auth.exchangeCodeForSession(code);

    if (error) {
      console.error('Error exchanging code for session:', error);
      // Redirect to login with error
      return NextResponse.redirect(`${origin}/login?error=auth_callback_error`);
    }

    // Get user to verify session was established
    const { data: { user } } = await supabase.auth.getUser();

    if (!user) {
      console.error('No user found after code exchange');
      return NextResponse.redirect(`${origin}/login?error=no_user`);
    }

    return NextResponse.redirect(`${origin}/dashboard`);
  }

  // No code provided - redirect to login
  return NextResponse.redirect(`${origin}/login`);
}
