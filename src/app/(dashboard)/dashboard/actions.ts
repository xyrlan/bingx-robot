'use server';

import { signOut } from '@/services/auth.service';
import { redirect } from 'next/navigation';

export async function signOutAction() {
  await signOut();
  redirect('/login');
}
