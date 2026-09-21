import { useEffect, useState, type FormEvent } from 'react';
import { Navigate } from 'react-router-dom';
import { z } from 'zod';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { apiClient, ApiError } from '@/lib/api-client';
import { useAuth } from '@/lib/auth';

const SetupResponseSchema = z.object({
  id: z.string(),
  email: z.string().email(),
  role: z.literal('admin'),
});
const SetupFormSchema = z
  .object({
    token: z.string().min(1, 'Enter the one-time setup token.'),
    email: z.string().email('Enter a valid administrator email address.'),
    password: z.string().min(12, 'Use at least 12 characters.'),
    confirmPassword: z.string(),
  })
  .refine(values => values.password === values.confirmPassword, {
    message: 'Passwords do not match.',
    path: ['confirmPassword'],
  });

type SetupState =
  | { readonly kind: 'checking' }
  | { readonly kind: 'alreadyDone' }
  | { readonly kind: 'idle' }
  | { readonly kind: 'submitting' }
  | { readonly kind: 'error'; readonly message: string }
  | { readonly kind: 'complete'; readonly email: string };

export function SetupPage() {
  const auth = useAuth();
  const [state, setState] = useState<SetupState>({ kind: 'checking' });

  useEffect(() => {
    let cancelled = false;
    async function probe(): Promise<void> {
      try {
        const res = await fetch('/api/setup', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: '{}',
        });
        if (res.status === 410 && !cancelled) setState({ kind: 'alreadyDone' });
        else if (!cancelled) setState({ kind: 'idle' });
      } catch {
        if (!cancelled) setState({ kind: 'idle' });
      }
    }
    void probe();
    return () => {
      cancelled = true;
    };
  }, []);

  if (auth.kind === 'authenticated') return <Navigate to="/" replace />;

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    const parsed = SetupFormSchema.safeParse({
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
        path: '/setup',
        body: {
          token: parsed.data.token,
          email: parsed.data.email,
          password: parsed.data.password,
        },
        schema: SetupResponseSchema,
      });
      setState({ kind: 'complete', email: result.email });
    } catch (error) {
      if (error instanceof ApiError && error.status === 410) {
        setState({ kind: 'alreadyDone' });
        return;
      }
      const message = 'Setup could not be completed. Check the token and details, then try again.';
      setState({ kind: 'error', message });
    }
  }

  if (state.kind === 'checking') {
    return (
      <div className="mx-auto max-w-lg space-y-6">
        <p className="text-sm text-[var(--color-muted-foreground)]">Checking setup status…</p>
      </div>
    );
  }

  if (state.kind === 'alreadyDone') {
    return (
      <div className="mx-auto max-w-lg space-y-6">
        <div className="space-y-2">
          <p className="text-xs font-semibold uppercase tracking-[0.08em] text-[var(--color-primary)]">
            Setup already completed
          </p>
          <h1 className="text-2xl font-semibold tracking-tight">
            This vault is already configured.
          </h1>
        </div>
        <Card>
          <CardContent className="space-y-4 pt-6">
            <p className="text-sm leading-6 text-[var(--color-muted-foreground)]">
              The one-time setup token has been permanently disabled after the first administrator
              was created. This is the correct, secure state for a Heartbeat Vault instance — setup
              is single-use by design.
            </p>
            <Button className="w-full" onClick={() => window.location.assign('/login')}>
              Go to sign in
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (state.kind === 'complete') {
    return (
      <div className="mx-auto max-w-lg space-y-6">
        <div className="space-y-2">
          <p className="text-xs font-semibold uppercase tracking-[0.08em] text-[var(--color-primary)]">
            Setup complete
          </p>
          <h1 className="text-2xl font-semibold tracking-tight">Your vault is ready.</h1>
        </div>
        <Card>
          <CardContent className="space-y-4 pt-6">
            <p className="text-sm leading-6 text-[var(--color-muted-foreground)]">
              {state.email} is now the instance administrator. The one-time setup token has been
              permanently disabled.
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
        <h1 className="text-2xl font-semibold tracking-tight">First-run setup</h1>
        <p className="text-sm text-[var(--color-muted-foreground)]">
          Create the first administrator account using the one-time token printed by the installer.
        </p>
      </div>
      <Card>
        <CardHeader>
          <CardTitle>Setup token</CardTitle>
          <CardDescription>
            Paste the one-time token printed by{' '}
            <code className="font-mono text-xs">install.sh</code>.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form className="space-y-4" onSubmit={submit} noValidate>
            <div className="space-y-2">
              <Label htmlFor="setup-token">Setup token</Label>
              <Input
                id="setup-token"
                name="token"
                type="password"
                autoComplete="one-time-code"
                placeholder="Paste the token from install.sh"
                required
              />
              <p className="text-xs text-[var(--color-muted-foreground)]">
                The token is single-use and expires. It is sent only to this instance.
              </p>
            </div>
            <div className="space-y-2">
              <Label htmlFor="setup-email">Administrator email</Label>
              <Input id="setup-email" name="email" type="email" autoComplete="email" required />
            </div>
            <div className="space-y-2">
              <Label htmlFor="setup-password">Password</Label>
              <Input
                id="setup-password"
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
              <Label htmlFor="setup-confirm-password">Confirm password</Label>
              <Input
                id="setup-confirm-password"
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
              {state.kind === 'submitting' ? 'Creating administrator…' : 'Create administrator'}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
