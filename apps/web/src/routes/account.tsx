import { useEffect, useState, type FormEvent } from 'react';
import { Navigate } from 'react-router-dom';
import { z } from 'zod';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useAuth } from '@/lib/auth';
import { ApiError, apiClient } from '@/lib/api-client';

const PasswordChangeSchema = z
  .object({
    currentPassword: z.string().min(1, 'Enter your current password.'),
    newPassword: z.string().min(12, 'Use at least 12 characters.'),
    confirmPassword: z.string(),
  })
  .refine(values => values.newPassword === values.confirmPassword, {
    message: 'Passwords do not match.',
    path: ['confirmPassword'],
  });
const OkResponseSchema = z.object({ ok: z.literal(true) });
const SessionSchema = z.object({
  id: z.string().uuid(),
  createdAt: z.string(),
  expiresAt: z.string(),
  revokedAt: z.string().nullable(),
  current: z.boolean(),
});
const SessionsSchema = z.array(SessionSchema);
const sessionPathByAction = {
  logout: '/logout',
  revokeAll: '/sessions/revoke-all',
} as const;

type PasswordFormState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'submitting' }
  | { readonly kind: 'success' }
  | { readonly kind: 'error'; readonly message: string };
type SessionAction = keyof typeof sessionPathByAction;
type SessionActionState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'submitting'; readonly action: SessionAction }
  | { readonly kind: 'error'; readonly action: SessionAction };

function formatSessionTime(value: string): string {
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(
    new Date(value),
  );
}

export function AccountPage() {
  const auth = useAuth();
  const [passwordState, setPasswordState] = useState<PasswordFormState>({ kind: 'idle' });
  const [sessionState, setSessionState] = useState<SessionActionState>({ kind: 'idle' });
  const [sessions, setSessions] = useState<readonly z.infer<typeof SessionSchema>[] | null>(null);

  async function changePassword(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const form = event.currentTarget;
    const formData = new FormData(form);
    const parsed = PasswordChangeSchema.safeParse({
      currentPassword: formData.get('currentPassword'),
      newPassword: formData.get('newPassword'),
      confirmPassword: formData.get('confirmPassword'),
    });
    if (!parsed.success) {
      setPasswordState({
        kind: 'error',
        message: parsed.error.issues[0]?.message ?? 'Check the password details and try again.',
      });
      return;
    }

    setPasswordState({ kind: 'submitting' });
    try {
      await apiClient.request({
        method: 'POST',
        path: '/account/password',
        body: {
          currentPassword: parsed.data.currentPassword,
          newPassword: parsed.data.newPassword,
        },
        schema: OkResponseSchema,
      });
      form.reset();
      setPasswordState({ kind: 'success' });
    } catch (error) {
      if (error instanceof ApiError) {
        setPasswordState({
          kind: 'error',
          message:
            error.status === 401
              ? 'Your current password is incorrect.'
              : 'Your password could not be updated. Try again.',
        });
        return;
      }
      throw error;
    }
  }

  async function endSessions(action: SessionAction): Promise<void> {
    setSessionState({ kind: 'submitting', action });
    try {
      await apiClient.request({
        method: 'POST',
        path: sessionPathByAction[action],
        schema: OkResponseSchema,
      });
      window.location.assign('/');
    } catch (error) {
      if (error instanceof ApiError) {
        setSessionState({ kind: 'error', action });
        return;
      }
      throw error;
    }
  }

  useEffect(() => {
    if (auth.kind !== 'authenticated') return;
    const controller = new AbortController();
    apiClient
      .request({ path: '/sessions', schema: SessionsSchema, signal: controller.signal })
      .then(setSessions)
      .catch(() => {
        if (!controller.signal.aborted) setSessions([]);
      });
    return () => controller.abort();
  }, [auth.kind]);

  if (auth.kind === 'loading') {
    return <p className="text-sm text-[var(--color-muted-foreground)]">Checking your session…</p>;
  }
  if (auth.kind === 'unauthenticated') return <Navigate to="/login" replace />;
  if (auth.kind === 'unavailable') {
    return (
      <section className="space-y-4">
        <h1 className="text-2xl font-semibold tracking-tight">Account unavailable</h1>
        <p className="text-sm text-[var(--color-muted-foreground)]">
          Your session could not be verified. Try again shortly.
        </p>
      </section>
    );
  }

  const { user } = auth;
  const isSubmittingPassword = passwordState.kind === 'submitting';
  const isSubmittingSession = sessionState.kind === 'submitting';

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <div className="space-y-2">
        <p className="text-xs font-mono uppercase tracking-[0.18em] text-[var(--color-muted-foreground)]">
          Account
        </p>
        <h1 className="text-2xl font-semibold tracking-tight">Account</h1>
      </div>
      <Card>
        <CardHeader>
          <CardTitle>Current user</CardTitle>
          <CardDescription>Signed-in account details for this vault.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-2 text-sm">
          <p>{user.email}</p>
          <p className="text-[var(--color-muted-foreground)]">Role: {user.role}</p>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Change password</CardTitle>
          <CardDescription>
            Use at least 12 characters for your replacement password.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form className="space-y-4" onSubmit={changePassword} noValidate>
            <div className="space-y-2">
              <Label htmlFor="current-password">Current password</Label>
              <Input
                id="current-password"
                name="currentPassword"
                type="password"
                autoComplete="current-password"
                disabled={isSubmittingPassword}
                required
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="new-password">New password</Label>
              <Input
                id="new-password"
                name="newPassword"
                type="password"
                autoComplete="new-password"
                disabled={isSubmittingPassword}
                required
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="confirm-new-password">Confirm new password</Label>
              <Input
                id="confirm-new-password"
                name="confirmPassword"
                type="password"
                autoComplete="new-password"
                disabled={isSubmittingPassword}
                required
              />
            </div>
            {passwordState.kind === 'error' ? (
              <p role="alert" className="text-sm text-[var(--color-destructive)]">
                {passwordState.message}
              </p>
            ) : null}
            {passwordState.kind === 'success' ? (
              <p role="status" className="text-sm text-[var(--color-muted-foreground)]">
                Password updated.
              </p>
            ) : null}
            <Button type="submit" disabled={isSubmittingPassword}>
              {isSubmittingPassword ? 'Updating password…' : 'Change password'}
            </Button>
          </form>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Sessions</CardTitle>
          <CardDescription>
            Logout ends this session. Revoking all sessions also signs you out everywhere else.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {sessions === null ? (
            <p className="text-sm text-[var(--color-muted-foreground)]">Loading sessions…</p>
          ) : sessions.length === 0 ? (
            <p className="text-sm text-[var(--color-muted-foreground)]">
              No sessions found for this account.
            </p>
          ) : (
            <ul className="divide-y rounded-md border">
              {sessions.map(session => (
                <li
                  key={session.id}
                  className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-sm"
                >
                  <span className="font-mono text-xs">{session.id.slice(0, 8)}…</span>
                  <span className="text-xs text-[var(--color-muted-foreground)]">
                    Created {formatSessionTime(session.createdAt)} · expires{' '}
                    {formatSessionTime(session.expiresAt)}
                  </span>
                  {session.revokedAt !== null ? (
                    <span className="rounded-full border px-2 py-0.5 text-xs">Revoked</span>
                  ) : session.current ? (
                    <span className="rounded-full border px-2 py-0.5 text-xs">This session</span>
                  ) : (
                    <span className="rounded-full border px-2 py-0.5 text-xs">Active</span>
                  )}
                </li>
              ))}
            </ul>
          )}
          <div className="flex flex-wrap gap-3">
            <Button
              type="button"
              variant="outline"
              disabled={isSubmittingSession}
              onClick={() => void endSessions('logout')}
            >
              {sessionState.kind === 'submitting' && sessionState.action === 'logout'
                ? 'Logging out…'
                : 'Logout'}
            </Button>
            <Button
              type="button"
              variant="destructive"
              disabled={isSubmittingSession}
              onClick={() => void endSessions('revokeAll')}
            >
              {sessionState.kind === 'submitting' && sessionState.action === 'revokeAll'
                ? 'Revoking sessions…'
                : 'Revoke all sessions'}
            </Button>
          </div>
          {sessionState.kind === 'error' ? (
            <p role="alert" className="text-sm text-[var(--color-destructive)]">
              The session action could not be completed. Try again.
            </p>
          ) : null}
        </CardContent>
      </Card>
    </div>
  );
}
