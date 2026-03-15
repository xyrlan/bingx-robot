'use client';

import { Select, ListBox } from '@heroui/react';
import { useActiveAccount } from '@/contexts/active-account';

export function AccountSwitcher() {
  const { accounts, activeAccountId, setActiveAccountId } = useActiveAccount();

  if (accounts.length === 0) return null;

  return (
    <div className="px-3 py-2 border-b border-default-200">
      <Select
        aria-label="Select account"
        value={activeAccountId}
        onChange={(value) => {
          if (value !== null) setActiveAccountId(String(value));
        }}
      >
        <Select.Trigger className="w-full">
          <Select.Value />
          <Select.Indicator />
        </Select.Trigger>
        <Select.Popover>
          <ListBox>
            {accounts.map((acc) => (
              <ListBox.Item key={acc.id} id={acc.id} textValue={acc.label}>
                {acc.label}
              </ListBox.Item>
            ))}
          </ListBox>
        </Select.Popover>
      </Select>
    </div>
  );
}
