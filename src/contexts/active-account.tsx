'use client';

import { createContext, useContext, useState, useEffect, useCallback, useRef, type ReactNode } from 'react';

type ApiKeyInfo = { id: string; label: string };

type ActiveAccountContextType = {
  accounts: ApiKeyInfo[];
  activeAccountId: string | null;
  setActiveAccountId: (id: string) => void;
  refreshAccounts: () => Promise<void>;
};

const ActiveAccountContext = createContext<ActiveAccountContextType | null>(null);

const ACTIVE_ACCOUNT_STORAGE_KEY = 'activeAccountId';

function readStoredAccountId(): string | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage.getItem(ACTIVE_ACCOUNT_STORAGE_KEY);
  } catch {
    return null;
  }
}

function writeStoredAccountId(id: string | null): void {
  if (typeof window === 'undefined') return;
  try {
    if (id) {
      window.localStorage.setItem(ACTIVE_ACCOUNT_STORAGE_KEY, id);
    } else {
      window.localStorage.removeItem(ACTIVE_ACCOUNT_STORAGE_KEY);
    }
  } catch {}
}

export function ActiveAccountProvider({ children }: { children: ReactNode }) {
  const [accounts, setAccounts] = useState<ApiKeyInfo[]>([]);
  const [activeAccountId, setActiveAccountIdState] = useState<string | null>(null);
  const activeIdRef = useRef<string | null>(null);

  useEffect(() => {
    activeIdRef.current = activeAccountId;
  }, [activeAccountId]);

  const setActiveAccountId = useCallback((id: string) => {
    setActiveAccountIdState(id);
    writeStoredAccountId(id);
  }, []);

  const refreshAccounts = useCallback(async () => {
    try {
      const res = await fetch('/api/bingx/keys');
      const data = await res.json();
      const keys: ApiKeyInfo[] = Array.isArray(data) ? data : data.keys ?? [];
      setAccounts(keys);

      if (keys.length === 0) {
        if (activeIdRef.current !== null) {
          setActiveAccountIdState(null);
          writeStoredAccountId(null);
        }
        return;
      }

      const ids = new Set(keys.map((k) => k.id));
      const current = activeIdRef.current;
      const stored = readStoredAccountId();

      let next: string;
      if (current && ids.has(current)) {
        next = current;
      } else if (stored && ids.has(stored)) {
        next = stored;
      } else {
        next = keys[0].id;
      }

      if (next !== current) {
        setActiveAccountIdState(next);
      }
      writeStoredAccountId(next);
    } catch {}
  }, []);

  useEffect(() => {
    queueMicrotask(() => {
      refreshAccounts();
    });
  }, [refreshAccounts]);

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
