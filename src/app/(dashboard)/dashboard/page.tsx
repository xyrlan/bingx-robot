import { createClient } from '@/lib/supabase/server';
import { db } from '@/db';
import { profiles } from '@/db/schema';
import { eq } from 'drizzle-orm';
import { Button } from '@heroui/react';
import Link from 'next/link';
import { signOutAction } from './actions';

export default async function DashboardPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return null;
  }

  const profile = await db.query.profiles.findFirst({
    where: eq(profiles.userId, user.id),
  });

  return (
    <div className="min-h-screen p-8">
      <div className="max-w-2xl mx-auto">
        <div className="flex items-center justify-between mb-8">
          <h1 className="text-2xl font-bold text-foreground">Dashboard</h1>
          <form action={signOutAction}>
            <Button type="submit" variant="outline" color="danger" as="button">
              Sign out
            </Button>
          </form>
        </div>

        <div className="rounded-lg border border-default-200 p-6 bg-background">
          <h2 className="text-lg font-semibold mb-4">Welcome</h2>
          <p className="text-default-600 mb-2">
            <strong>Email:</strong> {user.email}
          </p>
          {profile?.fullName && (
            <p className="text-default-600">
              <strong>Name:</strong> {profile.fullName}
            </p>
          )}
        </div>

        <p className="mt-6 text-sm text-default-500">
          <Link href="/" className="text-primary hover:underline">
            Back to home
          </Link>
        </p>
      </div>
    </div>
  );
}
