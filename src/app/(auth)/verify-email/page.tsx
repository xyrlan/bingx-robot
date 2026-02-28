'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { useTranslations } from 'next-intl';
import { useSearchParams, useRouter } from 'next/navigation';
import { CircleCheck, CircleX, Mail, Clock, RefreshCw, LogOut, User } from 'lucide-react';
import { Card, Button, Spinner } from '@heroui/react';
import { createClient } from '@/lib/supabase/client';

// Types for better state management
type VerificationState =
  | 'loading'
  | 'verifying'
  | 'success'
  | 'error'
  | 'waiting_for_token'
  | 'token_expired';

interface VerificationError {
  message: string;
  canRetry: boolean;
}

interface UserInfo {
  email: string;
  name?: string;
  emailConfirmed: boolean;
}

// Translation function type
type TranslationFunction = ReturnType<typeof useTranslations>;

/**
 * Email Verification Page
 * Displays different states: loading, verifying, success, error, waiting
 * Includes cooldown timer for resend and better UX feedback
 */
export default function VerifyEmailPage() {
  const t = useTranslations('Auth.VerifyEmail');
  const tErrors = useTranslations('Auth.Errors');
  const searchParams = useSearchParams();
  const router = useRouter();

  // State management
  const [state, setState] = useState<VerificationState>('loading');
  const [error, setError] = useState<VerificationError | null>(null);
  const [resendLoading, setResendLoading] = useState(false);
  const [resendCooldown, setResendCooldown] = useState(0);
  const [user, setUser] = useState<UserInfo | null>(null);

  // Refs for preventing duplicate operations
  const verificationAttemptedRef = useRef(false);
  const resendTimerRef = useRef<NodeJS.Timeout | null>(null);

  // Start cooldown timer for resend button
  const startResendCooldown = useCallback(() => {
    setResendCooldown(60); // 60 seconds cooldown

    const timer = setInterval(() => {
      setResendCooldown((prev) => {
        if (prev <= 1) {
          clearInterval(timer);
          return 0;
        }
        return prev - 1;
      });
    }, 1000);

    resendTimerRef.current = timer;
  }, []);

  // Cleanup timer on unmount
  useEffect(() => {
    return () => {
      if (resendTimerRef.current) {
        clearInterval(resendTimerRef.current);
      }
    };
  }, []);

  // Load user info from Supabase or localStorage
  const loadUserInfo = useCallback(async () => {
    const supabase = createClient();
    const { data: { user: supabaseUser } } = await supabase.auth.getUser();

    if (supabaseUser) {
      setUser({
        email: supabaseUser.email || '',
        name: supabaseUser.user_metadata?.fullName,
        emailConfirmed: supabaseUser.email_confirmed_at !== null,
      });
      return supabaseUser;
    }

    // Fallback to localStorage
    const emailFromStorage = localStorage.getItem('pendingVerificationEmail');
    if (emailFromStorage) {
      setUser({
        email: emailFromStorage,
        emailConfirmed: false,
      });
    }

    return null;
  }, []);

  // Email verification function
  const verifyUserEmail = useCallback(async (token: string) => {
    if (verificationAttemptedRef.current || state === 'verifying') {
      return;
    }

    verificationAttemptedRef.current = true;
    setState('verifying');
    setError(null);

    try {
      const supabase = createClient();
      const { error } = await supabase.auth.verifyOtp({
        token_hash: token,
        type: 'email',
      });

      if (error) {
        setState('error');
        setError({
          message: error.message === 'Token has expired or is invalid'
            ? tErrors('tokenInvalid')
            : error.message,
          canRetry: true,
        });
      } else {
        setState('success');
        // Clear localStorage
        localStorage.removeItem('pendingVerificationEmail');
        // Redirect after 2 seconds
        setTimeout(() => {
          router.push('/dashboard');
        }, 2000);
      }
    } catch (error) {
      console.error('Verification error:', error);
      setState('error');
      setError({
        message: tErrors('connectionError'),
        canRetry: true,
      });
    }
  }, [state, tErrors, router]);

  // Resend verification email function
  const resendVerificationEmail = useCallback(async () => {
    if (!user?.email || resendLoading || resendCooldown > 0) {
      return;
    }

    setResendLoading(true);

    try {
      const supabase = createClient();
      const { error } = await supabase.auth.resend({
        type: 'signup',
        email: user.email,
      });

      if (error) {
        setError({
          message: error.message,
          canRetry: true,
        });
      } else {
        startResendCooldown();
        setState('waiting_for_token');
      }
    } catch (error) {
      console.error('Resend error:', error);
      setError({
        message: tErrors('connectionError'),
        canRetry: true,
      });
    } finally {
      setResendLoading(false);
    }
  }, [user, resendLoading, resendCooldown, startResendCooldown, tErrors]);

  // Handle logout
  const handleLogout = useCallback(async () => {
    const supabase = createClient();
    await supabase.auth.signOut();
    localStorage.removeItem('pendingVerificationEmail');
    router.push('/login');
  }, [router]);

  // Initialize state based on URL and session
  useEffect(() => {
    const init = async () => {
      // Get token from URL
      const token = searchParams.get('token');
      const emailFromParams = searchParams.get('email');

      // Store email in localStorage if provided
      if (emailFromParams) {
        localStorage.setItem('pendingVerificationEmail', emailFromParams);
      }

      // Load user info
      const supabaseUser = await loadUserInfo();

      // Check if already verified
      if (supabaseUser?.email_confirmed_at) {
        router.push('/dashboard');
        return;
      }

      // If token in URL, verify it
      if (token && !verificationAttemptedRef.current) {
        await verifyUserEmail(token);
      } else {
        // No token, just waiting for user to click email link
        setState('waiting_for_token');
      }
    };

    init();
  }, [searchParams, loadUserInfo, verifyUserEmail, router]);

  // Determine what to render based on state
  const renderContent = () => {
    switch (state) {
      case 'loading':
        return <LoadingState />;

      case 'verifying':
        return <VerifyingState t={t} />;

      case 'success':
        return <SuccessState t={t} />;

      case 'error':
        return (
          <ErrorState
            t={t}
            error={error!}
            resendCooldown={resendCooldown}
            resendLoading={resendLoading}
            userEmail={user?.email}
            onResend={resendVerificationEmail}
          />
        );

      case 'waiting_for_token':
        return (
          <WaitingState
            t={t}
            resendCooldown={resendCooldown}
            resendLoading={resendLoading}
            userEmail={user?.email}
            onResend={resendVerificationEmail}
          />
        );

      case 'token_expired':
        return (
          <TokenExpiredState
            t={t}
            resendCooldown={resendCooldown}
            resendLoading={resendLoading}
            userEmail={user?.email}
            onResend={resendVerificationEmail}
          />
        );

      default:
        return (
          <WaitingState
            t={t}
            resendCooldown={0}
            userEmail={user?.email}
          />
        );
    }
  };

  return (
    <div className="flex flex-col items-center justify-center min-h-screen py-8 px-4 bg-gradient-to-br from-green-50 to-blue-100 dark:from-gray-900 dark:to-gray-800">
      <div className="w-full max-w-md space-y-6">
        {/* User info and logout button - only show if user is logged in */}
        {user && (
          <UserHeader
            t={t}
            user={user}
            onLogout={handleLogout}
          />
        )}

        {renderContent()}
      </div>
    </div>
  );
}

// ============= UI Components =============

interface UserHeaderProps {
  t: TranslationFunction;
  user: UserInfo;
  onLogout: () => void;
}

const UserHeader = ({ t, user, onLogout }: UserHeaderProps) => (
  <Card variant="default" className="w-full">
    <Card.Content>
      <div className="flex items-center justify-between p-4">
        <div className="flex items-center gap-3">
          <div className="rounded-full bg-primary/20 p-2">
            <User className="text-primary w-4 h-4" />
          </div>
          <div className="flex flex-col">
            <span className="text-sm font-medium text-foreground">
              {user.name || 'Usuário'}
            </span>
            <span className="text-xs text-default-500">
              {user.email}
            </span>
          </div>
        </div>

        <Button
          variant="danger"
          size="sm"
          onClick={onLogout}
        >
          <LogOut className="w-4 h-4 mr-1" />
          {t('userHeader.logout')}
        </Button>
      </div>

      {!user.emailConfirmed && (
        <div className="px-4 pb-4">
          <div className="pt-3 border-t border-default-200">
            <div className="flex items-center gap-2">
              <div className="w-2 h-2 rounded-full bg-warning" />
              <span className="text-xs text-default-600">
                {t('userHeader.pendingVerification')}
              </span>
            </div>
          </div>
        </div>
      )}
    </Card.Content>
  </Card>
);

const LoadingState = () => (
  <Card variant="default" className="w-full">
    <Card.Content>
      <div className="text-center py-8">
        <Spinner size="sm" color="accent" />
      </div>
    </Card.Content>
  </Card>
);

const VerifyingState = ({ t }: { t: TranslationFunction }) => (
  <Card variant="default" className="w-full">
    <Card.Content>
      <div className="text-center py-8 space-y-4">
        <Spinner size="sm" color="accent" />
        <h1 className="text-xl font-semibold">{t('states.verifying.title')}</h1>
        <p className="text-sm text-default-600">
          {t('states.verifying.description')}
        </p>
      </div>
    </Card.Content>
  </Card>
);

const SuccessState = ({ t }: { t: TranslationFunction }) => (
  <Card variant="default" className="w-full">
    <Card.Content>
      <div className="text-center py-8 space-y-4">
        <div className="flex justify-center">
          <div className="rounded-full bg-success/20 p-4">
            <CircleCheck className="text-success" size={48} />
          </div>
        </div>
        <h1 className="text-xl font-semibold text-success">
          {t('states.verified.title')}
        </h1>
        <p className="text-sm text-default-600">
          {t('states.verified.description')}
        </p>
        <div className="flex items-center justify-center gap-2 text-xs text-default-500 mt-2">
          <Spinner size="sm" />
          <span>{t('states.verified.redirecting')}</span>
        </div>
      </div>
    </Card.Content>
  </Card>
);

interface ErrorStateProps {
  t: TranslationFunction;
  error: VerificationError;
  onResend?: () => void;
  resendLoading?: boolean;
  resendCooldown: number;
  userEmail?: string;
}

const ErrorState = ({
  t,
  error,
  onResend,
  resendLoading,
  resendCooldown,
  userEmail,
}: ErrorStateProps) => (
  <Card variant="default" className="w-full">
    <Card.Content>
      <div className="text-center py-8 space-y-4">
        <div className="flex justify-center">
          <div className="rounded-full bg-danger/20 p-4">
            <CircleX className="text-danger" size={48} />
          </div>
        </div>
        <h1 className="text-xl font-semibold text-danger">
          {t('states.error.title')}
        </h1>
        <p className="text-sm text-default-600">{error.message}</p>

        {userEmail && (
          <div className="text-xs text-default-500 bg-default-100 p-3 rounded-lg mt-2">
            <Mail className="inline w-4 h-4 mr-1" />
            {userEmail}
          </div>
        )}

        {error.canRetry && onResend && (
          <div className="space-y-3 mt-4">
            <p className="text-sm text-default-600">
              {t('states.error.canRetry')}
            </p>
            <Button
              variant="primary"
              isDisabled={resendCooldown > 0 || resendLoading}
              onClick={onResend}
              className="w-full"
            >
              {resendLoading ? 'Carregando...' : resendCooldown > 0 ? (
                <>
                  <RefreshCw className="w-4 h-4 mr-2" />
                  {t('resendButton.waiting', { seconds: resendCooldown })}
                </>
              ) : (
                <>
                  <RefreshCw className="w-4 h-4 mr-2" />
                  {t('resendButton.ready')}
                </>
              )}
            </Button>
          </div>
        )}
      </div>
    </Card.Content>
  </Card>
);

interface WaitingProps {
  t: TranslationFunction;
  userEmail?: string;
  onResend?: () => void;
  resendLoading?: boolean;
  resendCooldown: number;
}

const WaitingState = ({
  t,
  userEmail,
  onResend,
  resendLoading,
  resendCooldown,
}: WaitingProps) => (
  <Card variant="default" className="w-full">
    <Card.Content>
      <div className="text-center py-8 space-y-4">
        <div className="flex justify-center">
          <div className="rounded-full bg-primary/20 p-4">
            <Mail className="text-primary" size={48} />
          </div>
        </div>
        <h1 className="text-xl font-semibold">{t('states.waiting.title')}</h1>
        <p className="text-sm text-default-600">{t('description')}</p>

        {userEmail && (
          <div className="text-xs text-default-500 bg-default-100 p-3 rounded-lg mt-2">
            <Mail className="inline w-4 h-4 mr-1" />
            {userEmail}
          </div>
        )}

        <div className="space-y-3 mt-4">
          <p className="text-xs text-default-500">
            {t('states.waiting.noReceived')}
          </p>

          {onResend && (
            <Button
              variant="primary"
              isDisabled={resendCooldown > 0 || resendLoading}
              onClick={onResend}
              className="w-full"
            >
              {resendLoading ? 'Carregando...' : resendCooldown > 0 ? (
                <>
                  <RefreshCw className="w-4 h-4 mr-2" />
                  {t('resendButton.waiting', { seconds: resendCooldown })}
                </>
              ) : (
                <>
                  <RefreshCw className="w-4 h-4 mr-2" />
                  {t('resendButton.ready')}
                </>
              )}
            </Button>
          )}
        </div>
      </div>
    </Card.Content>
  </Card>
);

const TokenExpiredState = ({
  t,
  userEmail,
  onResend,
  resendLoading,
  resendCooldown,
}: WaitingProps) => (
  <Card variant="default" className="w-full">
    <Card.Content>
      <div className="text-center py-8 space-y-4">
        <div className="flex justify-center">
          <div className="rounded-full bg-warning/20 p-4">
            <Clock className="text-warning" size={48} />
          </div>
        </div>
        <h1 className="text-xl font-semibold text-warning">
          {t('states.tokenExpired.title')}
        </h1>
        <p className="text-sm text-default-600">
          {t('states.tokenExpired.description')}
        </p>

        {userEmail && (
          <div className="text-xs text-default-500 bg-default-100 p-3 rounded-lg mt-2">
            <Mail className="inline w-4 h-4 mr-1" />
            {userEmail}
          </div>
        )}

        <div className="space-y-3 mt-4">
          <p className="text-xs text-default-500">
            {t('states.tokenExpired.checkInbox')}
          </p>

          {onResend && (
            <Button
              variant="primary"
              isDisabled={resendCooldown > 0 || resendLoading}
              onClick={onResend}
              className="w-full"
            >
              {resendLoading ? 'Carregando...' : resendCooldown > 0 ? (
                <>
                  <RefreshCw className="w-4 h-4 mr-2" />
                  {t('resendButton.waiting', { seconds: resendCooldown })}
                </>
              ) : (
                <>
                  <RefreshCw className="w-4 h-4 mr-2" />
                  {t('resendButton.ready')}
                </>
              )}
            </Button>
          )}
        </div>
      </div>
    </Card.Content>
  </Card>
);
