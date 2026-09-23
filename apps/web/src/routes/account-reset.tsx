import { useState, type FormEvent } from 'react';
import { Link, Navigate, useSearchParams } from 'react-router-dom';
import { z } from 'zod';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ApiError, apiClient } from '@/lib/api-client';
import { useAuth } from '@/lib/auth';

const ResetResponseSchema = z.object({ ok: z.literal(true) });
const AccountResetSchema = z
  .object({
    token: z.string().min(1, 'Enter the reset token.'),
    newPassword: z.string().min(12, 'Use at least 12 characters.'),
    confirmPassword: z.string(),
  })
  .refine(values => values.newPassword === values.confirmPassword, {
    message: 'Passwords do not match.',
    path: ['confirmPassword'],
  });

type ResetState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'submitting' }
  | { readonly kind: 'error'; readonly message: string }
  | { readonly kind: 'complete' };

export function AccountResetPage() {
  const auth = useAuth();
  const [searchParams] = useSearchParams();
  const [state, setState] = useState<ResetState>({ kind: 'idle' });
  const prefilledToken = searchParams.get('token') ?? '';

  if (auth.kind === 'authenticated') return <Navigate to="/" replace />;
  if (auth.kind === 'loading') {
    return <p className="text-sm text-[var(--color-muted-foreground)]">Checking your session…</p>;
  }

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    const parsed = AccountResetSchema.safeParse({
      token: formData.get('token'),
      newPassword: formData.get('newPassword'),
      confirmPassword: formData.get('confirmPassword'),
    });
    if (!parsed.success) {
      setState({
        kind: 'error',
        message: parsed.error.issues[0]?.message ?? 'Check the form and try again.',
      });
      return;
    }

    setState({ kind: 'submitting' });
    try {
      await apiClient.request({
        method: 'POST',
        path: '/account/password/reset',
        body: { token: parsed.data.token, newPassword: parsed.data.newPassword },
        schema: ResetResponseSchema,
      });
      setState({ kind: 'complete' });
    } catch (error) {
      setState({
        kind: 'error',
        message:
          error instanceof ApiError && error.status === 429
            ? 'Too many attempts. Please wait before trying again.'
            : 'Password reset could not be completed. Check the token and try again.',
      });
    }
  }

  if (state.kind === 'complete') {
    return (
      <div className="mx-auto max-w-lg space-y-6">
        <div className="space-y-2">
          <p className="text-xs font-semibold uppercase tracking-[0.08em] text-[var(--color-primary)]">
            Password reset complete
          </p>
          <h1 className="text-2xl font-semibold tracking-tight">Your password has been reset.</h1>
        </div>
        <Card>
          <CardContent className="space-y-4 pt-6">
            <p className="text-sm leading-6 text-[var(--color-muted-foreground)]">
              All of your sessions have been signed out.
            </p>
            <Link
              to="/login"
              className="block text-center text-sm font-medium text-[var(--color-primary)] hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-ring)] focus-visible:ring-offset-2"
            >
              Continue to sign in
            </Link>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-lg space-y-6">
      <div className="space-y-2">
        <h1 className="text-2xl font-semibold tracking-tight">Reset password</h1>
        <p className="text-sm text-[var(--color-muted-foreground)]">
          Enter the one-time reset token and choose a new password for your account.
        </p>
      </div>
      <Card>
        <CardHeader>
          <CardTitle>Set a new password</CardTitle>
          <CardDescription>Use at least 12 characters to protect your account.</CardDescription>
        </CardHeader>
        <CardContent>
          <form className="space-y-4" onSubmit={submit} noValidate>
            <div className="space-y-2">
              <Label htmlFor="reset-token">Reset token</Label>
              <Input
                id="reset-token"
                name="token"
                type="text"
                autoComplete="one-time-code"
                defaultValue={prefilledToken}
                placeholder="Paste the reset token"
                required
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="reset-new-password">New password</Label>
              <Input
                id="reset-new-password"
                name="newPassword"
                type="password"
                autoComplete="new-password"
                required
              />
              <p className="text-xs text-[var(--color-muted-foreground)]">
                Use at least 12 characters.
              </p>
            </div>
            <div className="space-y-2">
              <Label htmlFor="reset-confirm-password">Confirm new password</Label>
              <Input
                id="reset-confirm-password"
                name="confirmPassword"
                type="password"
                autoComplete="new-password"
                required
              />
            </div>
            {state.kind === 'error' ? (
              <p className="text-sm text-[var(--color-destructive)]" role="alert">
                {state.message}
              </p>
            ) : null}
            <Button type="submit" className="w-full" disabled={state.kind === 'submitting'}>
              {state.kind === 'submitting' ? 'Resetting password…' : 'Reset password'}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
