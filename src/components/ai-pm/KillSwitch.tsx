'use client';

// i18n: replace in Task 3
const STRINGS = {
  activate: 'Activate kill switch',
  release: 'Release kill switch',
  confirmTitle: 'Activate kill switch?',
  confirmBody: 'This will immediately halt all AI activity on this subaccount. Continue?',
  confirmYes: 'Confirm',
  confirmNo: 'Cancel',
};

import { useState } from 'react';
import { Button, Spinner, Modal, toast, useOverlayState } from '@heroui/react';
import { ShieldCheck, AlertTriangle } from 'lucide-react';

interface KillSwitchProps {
  configId: string;
  killSwitchOn: boolean;
  onChange: () => Promise<void>;
}

export function KillSwitch({ configId, killSwitchOn, onChange }: KillSwitchProps) {
  const [loading, setLoading] = useState(false);
  const confirmState = useOverlayState();

  async function doPatch(value: boolean) {
    setLoading(true);
    try {
      const res = await fetch(`/api/ai-pm/config/${configId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ killSwitch: value }),
      });
      if (!res.ok) {
        const data = await res.json() as { error?: string };
        toast.danger(data.error ?? 'Failed to update kill switch');
        return;
      }
      await onChange();
    } catch {
      toast.danger('Network error — please try again');
    } finally {
      setLoading(false);
    }
  }

  async function handlePress() {
    if (killSwitchOn) {
      // Release: no confirmation needed
      await doPatch(false);
    } else {
      // Activate: show confirm modal
      confirmState.open();
    }
  }

  async function handleConfirm() {
    confirmState.close();
    await doPatch(true);
  }

  return (
    <>
      <Button
        variant="outline"
        className={`${
          killSwitchOn
            ? 'border-amber-500 text-amber-600 hover:bg-amber-50 dark:text-amber-400 dark:hover:bg-amber-950/30'
            : 'border-red-500 text-red-600 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-950/30'
        }`}
        onPress={handlePress}
        isDisabled={loading}
        aria-label={killSwitchOn ? STRINGS.release : STRINGS.activate}
      >
        {loading ? (
          <Spinner size="sm" />
        ) : killSwitchOn ? (
          <>
            <ShieldCheck className="w-4 h-4 mr-1.5" aria-hidden="true" />
            {STRINGS.release}
          </>
        ) : (
          <>
            <AlertTriangle className="w-4 h-4 mr-1.5" aria-hidden="true" />
            {STRINGS.activate}
          </>
        )}
      </Button>

      {/* Confirm modal for activating kill switch */}
      <Modal state={confirmState}>
        <Modal.Backdrop isDismissable={!loading} />
        <Modal.Container size="sm">
          <Modal.Dialog>
            <Modal.Header>
              <Modal.Icon className="text-red-500">
                <AlertTriangle className="w-6 h-6" aria-hidden="true" />
              </Modal.Icon>
              <Modal.Heading>{STRINGS.confirmTitle}</Modal.Heading>
            </Modal.Header>
            <Modal.Body>
              <p className="text-sm text-slate-600 dark:text-slate-400">{STRINGS.confirmBody}</p>
            </Modal.Body>
            <Modal.Footer>
              <Button
                variant="outline"
                onPress={() => confirmState.close()}
                isDisabled={loading}
                aria-label={STRINGS.confirmNo}
              >
                {STRINGS.confirmNo}
              </Button>
              <Button
                variant="primary"
                className="bg-red-600 hover:bg-red-700 border-red-600 text-white"
                onPress={handleConfirm}
                isDisabled={loading}
                aria-label={STRINGS.confirmYes}
              >
                {loading ? <Spinner size="sm" /> : STRINGS.confirmYes}
              </Button>
            </Modal.Footer>
          </Modal.Dialog>
        </Modal.Container>
      </Modal>
    </>
  );
}
