'use client';

import { createContext, useContext, useState, useEffect, useCallback, type ReactNode } from 'react';

type ApiKeyInfo = { id: string; label: string };

type ActiveAccountContextType = {
  accounts: ApiKeyInfo[];
  activeAccountId: string | null;
  setActiveAccountId: (id: string) => void;
  refreshAccounts: () => Promise<void>;
};

const ActiveAccountContext = createContext<ActiveAccountContextType | null>(null);

export function ActiveAccountProvider({ children }: { children: ReactNode }) {
  const [accounts, setAccounts] = useState<ApiKeyInfo[]>([]);
  const [activeAccountId, setActiveAccountId] = useState<string | null>(null);

  const refreshAccounts = useCallback(async () => {
    try {
      const res = await fetch('/api/bingx/keys');
      const data = await res.json();
      const keys: ApiKeyInfo[] = Array.isArray(data) ? data : data.keys ?? [];
      setAccounts(keys);
      if (keys.length > 0 && !activeAccountId) {
        setActiveAccountId(keys[0].id);
      }
    } catch {}
  }, [activeAccountId]);

  useEffect(() => {
    refreshAccounts();
  }, []);

  return (
    <ActiveAccountContext.Provider
      value={{ accounts, activeAccountId, setActiveAccountId, refreshAccounts }}
    >
      {children}
    </ActiveAccountContext.Provider>
  );
}

export function useActiveAccount() {
  const ctx = useContext(ActiveAccountContext);
  if (!ctx) throw new Error('useActiveAccount must be used within ActiveAccountProvider');
  return ctx;
}
