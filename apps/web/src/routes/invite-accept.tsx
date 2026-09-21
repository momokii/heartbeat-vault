import { useState, type FormEvent } from 'react';
import { Navigate, useSearchParams } from 'react-router-dom';
import { z } from 'zod';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { apiClient, ApiError } from '@/lib/api-client';
import { useAuth } from '@/lib/auth';

const ConsumeResponseSchema = z.object({
  id: z.string(),
  email: z.string().email(),
  role: z.string(),
});
const InviteAcceptSchema = z
  .object({
    token: z.string().min(1, 'Enter the invitation token.'),
    email: z.string().email('Enter a valid email address.'),
    password: z.string().min(12, 'Use at least 12 characters.'),
    confirmPassword: z.string(),
  })
  .refine(values => values.password === values.confirmPassword, {
    message: 'Passwords do not match.',
    path: ['confirmPassword'],
  });

type AcceptState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'submitting' }
  | { readonly kind: 'error'; readonly message: string }
  | { readonly kind: 'complete'; readonly email: string; readonly role: string };

export function InviteAcceptPage() {
  const auth = useAuth();
  const [searchParams] = useSearchParams();
  const [state, setState] = useState<AcceptState>({ kind: 'idle' });
  const prefilledToken = searchParams.get('token') ?? '';

  if (auth.kind === 'authenticated') return <Navigate to="/" replace />;
  if (auth.kind === 'loading') {
    return <p className="text-sm text-[var(--color-muted-foreground)]">Checking your session…</p>;
  }

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    const parsed = InviteAcceptSchema.safeParse({
      token: formData.get('token'),
      email: formData.get('email'),
      password: formData.get('password'),
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
      const result = await apiClient.request({
        method: 'POST',
        path: '/invites/consume',
        body: {
          token: parsed.data.token,
          email: parsed.data.email,
          password: parsed.data.password,
        },
        schema: ConsumeResponseSchema,
      });
      setState({ kind: 'complete', email: result.email, role: result.role });
    } catch (error) {
      setState({
        kind: 'error',
        message:
          error instanceof ApiError && error.status === 429
            ? 'Too many attempts. Please wait before trying again.'
            : 'Invitation could not be accepted. Check the token, email, and password, then try again.',
      });
    }
  }

  if (state.kind === 'complete') {
    return (
      <div className="mx-auto max-w-lg space-y-6">
        <div className="space-y-2">
          <p className="text-xs font-semibold uppercase tracking-[0.08em] text-[var(--color-primary)]">
            Invitation accepted
          </p>
          <h1 className="text-2xl font-semibold tracking-tight">Your account is ready.</h1>
        </div>
        <Card>
          <CardContent className="space-y-4 pt-6">
            <p className="text-sm leading-6 text-[var(--color-muted-foreground)]">
              {state.email} was created with role {state.role}. The invitation is now consumed and
              cannot be reused.
            </p>
            <Button className="w-full" onClick={() => window.location.assign('/login')}>
              Continue to sign in
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-lg space-y-6">
      <div className="space-y-2">
        <h1 className="text-2xl font-semibold tracking-tight">Accept invitation</h1>
        <p className="text-sm text-[var(--color-muted-foreground)]">
          Use the one-time invitation token from your administrator to create your account. Tokens
          expire after 24 hours and are single-use.
        </p>
      </div>
      <Card>
        <CardHeader>
          <CardTitle>Invitation</CardTitle>
          <CardDescription>
            Paste the token, confirm the invited email, set a password.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form className="space-y-4" onSubmit={submit} noValidate>
            <div className="space-y-2">
              <Label htmlFor="invite-token">Invitation token</Label>
              <Input
                id="invite-token"
                name="token"
                type="text"
                autoComplete="one-time-code"
                defaultValue={prefilledToken}
                placeholder="Paste the invitation token"
                required
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="invite-email">Email</Label>
              <Input id="invite-email" name="email" type="email" autoComplete="email" required />
              <p className="text-xs text-[var(--color-muted-foreground)]">
                Must match the email address the invitation was created for.
              </p>
            </div>
            <div className="space-y-2">
              <Label htmlFor="invite-password">Password</Label>
              <Input
                id="invite-password"
                name="password"
                type="password"
                autoComplete="new-password"
                required
              />
              <p className="text-xs text-[var(--color-muted-foreground)]">
                Use at least 12 characters.
              </p>
            </div>
            <div className="space-y-2">
              <Label htmlFor="invite-confirm-password">Confirm password</Label>
              <Input
                id="invite-confirm-password"
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
              {state.kind === 'submitting' ? 'Creating account…' : 'Create account'}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
