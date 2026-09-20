import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { z } from 'zod';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { apiClient, ApiError } from '@/lib/api-client';

const codeSchema = z.string().regex(/^\d{6}$/, 'Enter the six-digit code from your authenticator.');
const responseSchema = z.object({ ok: z.literal(true) });
type State =
  | { readonly kind: 'idle' }
  | { readonly kind: 'submitting' }
  | { readonly kind: 'error'; readonly message: string };

export function TotpChallengePage() {
  const [state, setState] = useState<State>({ kind: 'idle' });
  const navigate = useNavigate();
  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const code = new FormData(event.currentTarget).get('code');
    const parsed = codeSchema.safeParse(code);
    if (!parsed.success) {
      setState({
        kind: 'error',
        message: parsed.error.issues[0]?.message ?? 'Enter your verification code.',
      });
      return;
    }
    setState({ kind: 'submitting' });
    try {
      await apiClient.request({
        method: 'POST',
        path: '/2fa/totp/challenge',
        body: { code: parsed.data },
        schema: responseSchema,
      });
      navigate('/');
    } catch (error) {
      setState({
        kind: 'error',
        message:
          error instanceof ApiError && error.status === 429
            ? 'Too many attempts. Please wait before trying again.'
            : 'That verification code is not valid. Try again.',
      });
    }
  }
  return (
    <div className="mx-auto max-w-md space-y-6">
      <div className="space-y-2">
        <p className="text-xs font-mono uppercase tracking-[0.18em] text-[var(--color-muted-foreground)]">
          Two-step verification
        </p>
        <h1 className="text-2xl font-semibold tracking-tight">Confirm your sign-in</h1>
        <p className="text-sm text-[var(--color-muted-foreground)]">
          Enter the current code from your authenticator app to finish signing in.
        </p>
      </div>
      <Card>
        <CardHeader>
          <CardTitle>Verification code</CardTitle>
          <CardDescription>The code expires quickly and can only be used once.</CardDescription>
        </CardHeader>
        <CardContent>
          <form className="space-y-4" onSubmit={submit} noValidate>
            <div className="space-y-2">
              <Label htmlFor="totp-code">Authenticator code</Label>
              <Input
                id="totp-code"
                name="code"
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={6}
                required
                disabled={state.kind === 'submitting'}
              />
            </div>
            {state.kind === 'error' ? (
              <p role="alert" className="text-sm text-[var(--color-destructive)]">
                {state.message}
              </p>
            ) : null}
            <Button type="submit" className="w-full" disabled={state.kind === 'submitting'}>
              {state.kind === 'submitting' ? 'Verifying…' : 'Verify and sign in'}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
