'use client';

import { useActionState } from 'react';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { Card, TextField, Input, Label, Button } from '@heroui/react';
import { registerAction } from './actions';

export default function RegisterPage() {
  const t = useTranslations('Auth.Register');
  const [state, formAction, isPending] = useActionState(registerAction, null);

  return (
    <div className="min-h-screen flex items-center justify-center p-4">
      <Card variant="default" className="w-full max-w-md">
        <Card.Content className="p-8">
          <div className="text-center mb-8">
            <h1 className="text-3xl font-bold text-foreground mb-2">
              {t('title')}
            </h1>
            <p className="text-sm text-muted">{t('subtitle')}</p>
          </div>

          <form action={formAction} className="space-y-4">
            {state?.error && (
              <div className="p-3 bg-danger/10 border border-danger rounded-lg">
                <p className="text-sm text-danger">{state.error}</p>
              </div>
            )}

            <TextField variant="primary" isDisabled={isPending} isRequired>
              <Label>{t('fullName')}</Label>
              <Input name="fullName" placeholder="John Doe" />
            </TextField>

            <TextField variant="primary" isDisabled={isPending} isRequired>
              <Label>{t('email')}</Label>
              <Input name="email" type="email" placeholder="john@example.com" />
            </TextField>

            <TextField variant="primary" isDisabled={isPending} isRequired>
              <Label>{t('password')}</Label>
              <Input name="password" type="password" placeholder={t('passwordPlaceholder')} />
            </TextField>

            <Button
              type="submit"
              variant="primary"
              className="w-full"
              isDisabled={isPending}
              size="lg"
            >
              {isPending ? t('submitting') : t('submit')}
            </Button>
          </form>

          <div className="mt-6 text-center">
            <p className="text-sm text-muted">
              {t('hasAccount')}{' '}
              <Link href="/login" className="text-accent hover:underline font-medium">
                {t('login')}
              </Link>
            </p>
          </div>
        </Card.Content>
      </Card>
    </div>
  );
}
