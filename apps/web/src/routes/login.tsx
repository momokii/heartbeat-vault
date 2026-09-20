import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { apiClient, ApiError } from '@/lib/api-client';

const LoginResponseSchema = z.union([
  z.object({ id: z.string(), email: z.string().email(), role: z.string() }),
  z.object({ stepUp: z.literal('totp') }),
]);

type LoginState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'submitting' }
  | { readonly kind: 'error'; readonly message: string }
  | { readonly kind: 'step-up' };

export function LoginPage() {
  const [state, setState] = useState<LoginState>({ kind: 'idle' });
  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const email = form.get('email');
    const password = form.get('password');
    if (typeof email !== 'string' || typeof password !== 'string' || !email || !password) {
      setState({ kind: 'error', message: 'Enter your email address and password.' });
      return;
    }
    setState({ kind: 'submitting' });
    try {
      const result = await apiClient.request({
        method: 'POST',
        path: '/login',
        body: { email, password },
        schema: LoginResponseSchema,
      });
      if ('stepUp' in result) {
        setState({ kind: 'step-up' });
        return;
      }
      window.location.assign('/');
    } catch (error) {
      setState({
        kind: 'error',
        message:
          error instanceof ApiError && error.status === 429
            ? 'Too many attempts. Please wait before trying again.'
            : 'Email or password is incorrect.',
      });
    }
  }
  if (state.kind === 'step-up')
    return (
      <div className="mx-auto max-w-md space-y-6">
        <h1 className="text-2xl font-semibold tracking-tight">Confirm your sign-in</h1>
        <Card>
          <CardContent className="space-y-4 pt-6">
            <p className="text-sm text-[var(--color-muted-foreground)]">
              Enter the verification code from your authenticator to finish signing in.
            </p>
            <Button className="w-full" onClick={() => window.location.assign('/2fa/totp')}>
              Continue to verification
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  return (
    <div className="mx-auto max-w-md space-y-6">
      <div className="space-y-2">
        <h1 className="text-2xl font-semibold tracking-tight">Sign in</h1>
        <p className="text-sm text-[var(--color-muted-foreground)]">
          Sign in to manage your switches and review their release status.
        </p>
      </div>
      <Card>
        <CardHeader>
          <CardTitle>Login</CardTitle>
          Your session is secured with an HTTP-only cookie.
        </CardHeader>
        <CardContent>
          <form className="space-y-4" onSubmit={submit} aria-describedby="login-hint">
            <div className="space-y-2">
              <Label htmlFor="login-email">Email</Label>
              <Input id="login-email" name="email" type="email" autoComplete="email" required />
            </div>
            <div className="space-y-2">
              <Label htmlFor="login-password">Password</Label>
              <Input
                id="login-password"
                name="password"
                type="password"
                autoComplete="current-password"
                required
              />
              <p id="login-hint" className="text-xs text-[var(--color-muted-foreground)]">
                Use your account password. Sign-ins may require a second verification step.
              </p>
            </div>
            {state.kind === 'error' ? (
              <p role="alert" className="text-sm text-[var(--color-destructive)]">
                {state.message}
              </p>
            ) : null}
            <Button type="submit" className="w-full" disabled={state.kind === 'submitting'}>
              {state.kind === 'submitting' ? 'Signing in…' : 'Continue'}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
import { useState, type FormEvent } from 'react';
import { z } from 'zod';
