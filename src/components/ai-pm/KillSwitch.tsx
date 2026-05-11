'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Button, Spinner, Card, toast } from '@heroui/react';
import { ShieldCheck, AlertTriangle } from 'lucide-react';

interface KillSwitchProps {
  configId: string;
  killSwitchOn: boolean;
  onChange: () => Promise<void>;
}

export function KillSwitch({ configId, killSwitchOn, onChange }: KillSwitchProps) {
  const t = useTranslations('AiPm.Settings');
  const [loading, setLoading] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);

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
      await doPatch(false);
    } else {
      setConfirmOpen(true);
    }
  }

  async function handleConfirm() {
    setConfirmOpen(false);
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
        aria-label={killSwitchOn ? t('killSwitchRelease') : t('killSwitchActivate')}
      >
        {loading ? (
          <Spinner size="sm" />
        ) : killSwitchOn ? (
          <>
            <ShieldCheck className="w-4 h-4 mr-1.5" aria-hidden="true" />
            {t('killSwitchRelease')}
          </>
        ) : (
          <>
            <AlertTriangle className="w-4 h-4 mr-1.5" aria-hidden="true" />
            {t('killSwitchActivate')}
          </>
        )}
      </Button>

      {confirmOpen && (
        <div
          className="fixed inset-0 z-50 flex items-end md:items-center md:justify-center bg-black/50"
          onClick={(e) => { if (e.target === e.currentTarget && !loading) setConfirmOpen(false); }}
          role="dialog"
          aria-modal="true"
          aria-label={t('killSwitchActivate')}
        >
          <Card
            variant="default"
            className="w-full rounded-t-2xl md:rounded-xl md:max-w-md md:mx-4 max-h-[90vh] overflow-y-auto overscroll-contain"
            onClick={(e) => e.stopPropagation()}
          >
            <Card.Content className="p-6 safe-area-pb">
              <div className="md:hidden w-10 h-1 rounded-full bg-default-300 mx-auto mb-4" />
              <div className="flex items-start gap-3 mb-3">
                <div className="text-red-500 shrink-0 mt-0.5">
                  <AlertTriangle className="w-6 h-6" aria-hidden="true" />
                </div>
                <h3 className="text-lg font-semibold text-slate-900 dark:text-slate-100">
                  {t('killSwitchActivate')}?
                </h3>
              </div>
              <p className="text-sm text-slate-600 dark:text-slate-400 mb-6">
                {t('killSwitchConfirm')}
              </p>
              <div className="flex justify-end gap-2">
                <Button
                  variant="outline"
                  onPress={() => setConfirmOpen(false)}
                  isDisabled={loading}
                  aria-label={t('cancel')}
                >
                  {t('cancel')}
                </Button>
                <Button
                  variant="primary"
                  className="bg-red-600 hover:bg-red-700 border-red-600 text-white"
                  onPress={handleConfirm}
                  isDisabled={loading}
                  aria-label={t('confirm')}
                >
                  {loading ? <Spinner size="sm" /> : t('confirm')}
                </Button>
              </div>
            </Card.Content>
          </Card>
        </div>
      )}
    </>
  );
}
