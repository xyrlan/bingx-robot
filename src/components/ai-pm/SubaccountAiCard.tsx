'use client';

// i18n: replace in Task 3
const STRINGS = {
  enableAi: 'Enable AI',
  editProfile: 'Edit profile',
  replaceKey: 'Replace Anthropic key',
  disableAi: 'Disable AI',
  confirmDisable: 'This will delete the AI configuration for this subaccount. Are you sure?',
  statusEnabled: 'Enabled',
  statusDisabled: 'Disabled',
  statusPaper: 'Paper',
  statusKillSwitch: 'Kill switch',
  enabledLabel: 'Enabled',
  enabledDesc: 'AI portfolio manager is active.',
  disabledDesc: 'AI portfolio manager is paused.',
};

import { useState, useEffect } from 'react';
import { Card, Button, Spinner, Switch, Modal, toast, useOverlayState } from '@heroui/react';
import { KeyRound, Settings, Trash2, AlertTriangle } from 'lucide-react';
import type { AiPmConfigPublic } from './types';
import { AnthropicKeyForm } from './AnthropicKeyForm';
import { GuardrailForm } from './GuardrailForm';
import { KillSwitch } from './KillSwitch';
import { PaperModeToggle } from './PaperModeToggle';

interface SubaccountAiCardProps {
  subaccount: { id: string; label: string };
  config: AiPmConfigPublic | null;
  onChange: () => Promise<void>;
}

export function SubaccountAiCard({ subaccount, config, onChange }: SubaccountAiCardProps) {
  const [showEnableFlow, setShowEnableFlow] = useState(false);
  // pendingConfig: set after AnthropicKeyForm creates the config; drives GuardrailForm step
  const [pendingConfig, setPendingConfig] = useState<AiPmConfigPublic | null>(null);
  const [showEditProfile, setShowEditProfile] = useState(false);
  const [showReplaceKey, setShowReplaceKey] = useState(false);
  // Optimistic enabled state
  const [optimisticEnabled, setOptimisticEnabled] = useState(config?.enabled ?? false);
  const [patchingEnabled, setPatchingEnabled] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const disableModalState = useOverlayState();

  // Keep optimistic state in sync when parent refreshes config
  useEffect(() => {
    setOptimisticEnabled(config?.enabled ?? false);
  }, [config?.enabled]);

  // ---- Toggle enabled (optimistic) ----
  async function handleEnabledChange(checked: boolean) {
    if (!config) return;
    setOptimisticEnabled(checked);
    setPatchingEnabled(true);
    try {
      const res = await fetch(`/api/ai-pm/config/${config.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: checked }),
      });
      if (!res.ok) {
        const data = await res.json() as { error?: string };
        setOptimisticEnabled(!checked);
        toast.danger(data.error ?? 'Failed to update');
        return;
      }
      await onChange();
    } catch {
      setOptimisticEnabled(!checked);
      toast.danger('Network error — please try again');
    } finally {
      setPatchingEnabled(false);
    }
  }

  // ---- Delete (disable AI) ----
  async function handleDelete() {
    if (!config) return;
    disableModalState.close();
    setDeleting(true);
    try {
      const res = await fetch(`/api/ai-pm/config/${config.id}`, { method: 'DELETE' });
      if (!res.ok) {
        const data = await res.json() as { error?: string };
        toast.danger(data.error ?? 'Failed to disable AI');
        return;
      }
      toast.success('AI disabled for this subaccount');
      await onChange();
    } catch {
      toast.danger('Network error — please try again');
    } finally {
      setDeleting(false);
    }
  }

  // ---- After AnthropicKeyForm saves a NEW config: move to GuardrailForm step ----
  function handleKeySaved(cfg: AiPmConfigPublic) {
    setPendingConfig(cfg);
    // Notify parent so list refreshes, but keep enable flow open for guardrail step
    void onChange();
  }

  // ---- After GuardrailForm saves in the enable flow ----
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async function handleGuardrailSaved(_cfg: AiPmConfigPublic) {
    setPendingConfig(null);
    setShowEnableFlow(false);
    await onChange();
  }

  // ---- After saving in edit/replace flows ----
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async function handleEditSaved(_cfg: AiPmConfigPublic) {
    setShowEditProfile(false);
    setShowReplaceKey(false);
    await onChange();
  }

  // ---- Status pills ----
  function StatusPills() {
    if (!config) return null;
    const isActive = config.enabled && !config.killSwitch;
    return (
      <div className="flex flex-wrap gap-1.5">
        <span
          className={`inline-flex items-center text-xs font-medium px-2 py-0.5 rounded-full ${
            isActive
              ? 'bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-400'
              : 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-400'
          }`}
        >
          {isActive ? STRINGS.statusEnabled : STRINGS.statusDisabled}
        </span>
        {config.paperMode && (
          <span className="inline-flex items-center text-xs font-medium px-2 py-0.5 rounded-full bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-400">
            {STRINGS.statusPaper}
          </span>
        )}
        {config.killSwitch && (
          <span className="inline-flex items-center text-xs font-medium px-2 py-0.5 rounded-full bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-400">
            {STRINGS.statusKillSwitch}
          </span>
        )}
      </div>
    );
  }

  return (
    <Card variant="default" className="p-4 sm:p-6">
      <Card.Content className="p-0 space-y-4">
        {/* Header */}
        <div className="flex items-center justify-between gap-3">
          <div>
            <p className="font-semibold text-slate-900 dark:text-slate-100">{subaccount.label}</p>
            {config && <StatusPills />}
          </div>
        </div>

        {/* === No config: show Enable AI button + expandable two-step form === */}
        {!config && (
          <div className="space-y-3">
            {!showEnableFlow ? (
              <Button
                variant="primary"
                onPress={() => setShowEnableFlow(true)}
                aria-label={`Enable AI for ${subaccount.label}`}
              >
                {STRINGS.enableAi}
              </Button>
            ) : (
              <div className="space-y-4">
                {/* Step 1: Anthropic key — hidden once key is saved */}
                {pendingConfig === null && (
                  <div className="space-y-3">
                    <p className="text-sm font-medium text-slate-900 dark:text-slate-100">
                      Set up Anthropic key
                    </p>
                    <AnthropicKeyForm
                      existingConfigId={null}
                      bingxApiKeyId={subaccount.id}
                      defaultMode="BALANCED"
                      onSaved={handleKeySaved}
                      onCancel={() => setShowEnableFlow(false)}
                    />
                  </div>
                )}

                {/* Step 2: Guardrails — shown once config is created */}
                {pendingConfig !== null && (
                  <div className="border-t border-default-200 pt-4">
                    <p className="text-sm font-medium text-slate-900 dark:text-slate-100 mb-3">
                      Configure guardrails
                    </p>
                    <GuardrailForm
                      config={pendingConfig}
                      configId={pendingConfig.id}
                      onSaved={handleGuardrailSaved}
                      onCancel={() => handleGuardrailSaved(pendingConfig)}
                    />
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {/* === Has config: show toggles + action buttons === */}
        {config && (
          <div className="space-y-4">
            {/* Switches */}
            <div className="space-y-3">
              {/* Enabled toggle — optimistic */}
              <div className="flex items-start gap-3">
                <Switch
                  isSelected={optimisticEnabled}
                  onChange={handleEnabledChange}
                  isDisabled={patchingEnabled || deleting}
                  aria-label={STRINGS.enabledLabel}
                >
                  <Switch.Control>
                    <Switch.Thumb />
                  </Switch.Control>
                </Switch>
                <div className="min-w-0">
                  <p className="text-sm font-medium text-slate-900 dark:text-slate-100">{STRINGS.enabledLabel}</p>
                  <p className="text-xs text-slate-500 dark:text-slate-400">
                    {optimisticEnabled ? STRINGS.enabledDesc : STRINGS.disabledDesc}
                  </p>
                </div>
                {patchingEnabled && <Spinner size="sm" />}
              </div>

              {/* Paper mode toggle — delegates to PaperModeToggle (has its own optimistic state) */}
              <PaperModeToggle
                configId={config.id}
                paperMode={config.paperMode}
                onChange={onChange}
              />
            </div>

            {/* Action buttons */}
            <div className="flex flex-wrap gap-2">
              <Button
                variant="outline"
                size="sm"
                onPress={() => { setShowEditProfile((v) => !v); setShowReplaceKey(false); }}
                isDisabled={deleting}
                aria-label="Edit AI profile and guardrails"
              >
                <Settings className="w-4 h-4 mr-1.5" aria-hidden="true" />
                {STRINGS.editProfile}
              </Button>
              <Button
                variant="outline"
                size="sm"
                onPress={() => { setShowReplaceKey((v) => !v); setShowEditProfile(false); }}
                isDisabled={deleting}
                aria-label="Replace Anthropic API key"
              >
                <KeyRound className="w-4 h-4 mr-1.5" aria-hidden="true" />
                {STRINGS.replaceKey}
              </Button>
              <Button
                variant="outline"
                size="sm"
                className="text-red-600 border-red-500 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-950/30"
                onPress={() => disableModalState.open()}
                isDisabled={deleting}
                aria-label="Disable AI for this subaccount"
              >
                {deleting ? (
                  <Spinner size="sm" />
                ) : (
                  <>
                    <Trash2 className="w-4 h-4 mr-1.5" aria-hidden="true" />
                    {STRINGS.disableAi}
                  </>
                )}
              </Button>
            </div>

            {/* Inline: Edit profile form */}
            {showEditProfile && (
              <div className="border-t border-default-200 pt-4">
                <GuardrailForm
                  config={config}
                  configId={config.id}
                  onSaved={handleEditSaved}
                  onCancel={() => setShowEditProfile(false)}
                />
              </div>
            )}

            {/* Inline: Replace Anthropic key form */}
            {showReplaceKey && (
              <div className="border-t border-default-200 pt-4">
                <AnthropicKeyForm
                  existingConfigId={config.id}
                  bingxApiKeyId={config.bingxApiKeyId}
                  onSaved={handleEditSaved}
                  onCancel={() => setShowReplaceKey(false)}
                />
              </div>
            )}

            {/* Kill switch below switches */}
            <div className="border-t border-default-200 pt-4">
              <KillSwitch
                configId={config.id}
                killSwitchOn={config.killSwitch}
                onChange={onChange}
              />
            </div>
          </div>
        )}
      </Card.Content>

      {/* Confirm disable modal */}
      <Modal state={disableModalState}>
        <Modal.Backdrop isDismissable={!deleting} />
        <Modal.Container size="sm">
          <Modal.Dialog>
            <Modal.Header>
              <Modal.Icon className="text-red-500">
                <AlertTriangle className="w-6 h-6" aria-hidden="true" />
              </Modal.Icon>
              <Modal.Heading>Disable AI?</Modal.Heading>
            </Modal.Header>
            <Modal.Body>
              <p className="text-sm text-slate-600 dark:text-slate-400">{STRINGS.confirmDisable}</p>
            </Modal.Body>
            <Modal.Footer>
              <Button
                variant="outline"
                onPress={() => disableModalState.close()}
                isDisabled={deleting}
                aria-label="Cancel"
              >
                Cancel
              </Button>
              <Button
                variant="primary"
                className="bg-red-600 hover:bg-red-700 border-red-600 text-white"
                onPress={handleDelete}
                isDisabled={deleting}
                aria-label="Confirm disable AI"
              >
                {deleting ? <Spinner size="sm" /> : 'Disable AI'}
              </Button>
            </Modal.Footer>
          </Modal.Dialog>
        </Modal.Container>
      </Modal>
    </Card>
  );
}
