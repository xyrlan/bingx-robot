'use client';

import { useEffect } from 'react';

export default function AccountsError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error('Accounts page error:', error);
  }, [error]);

  return (
    <div className="flex min-h-[40vh] flex-col items-center justify-center gap-4">
      <div className="rounded-lg border border-danger/30 bg-danger/10 p-6 text-center">
        <h2 className="mb-2 text-lg font-semibold text-danger">
          Failed to load accounts
        </h2>
        <p className="mb-4 text-sm text-danger/80">
          {error.message || 'Could not load your account information'}
        </p>
        <button
          onClick={reset}
          className="rounded-md bg-danger px-4 py-2 text-sm font-medium text-danger-foreground transition-colors hover:bg-danger/90"
        >
          Retry
        </button>
      </div>
    </div>
  );
}
