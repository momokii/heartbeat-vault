import { useState, type FormEvent } from 'react';
import { z } from 'zod';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ApiError, apiClient } from '@/lib/api-client';

const testReleaseResponseSchema = z.object({
  ok: z.literal(true),
  channelCount: z.number().int().nonnegative(),
});

function errorMessage(error: unknown): string {
  if (error instanceof ApiError && error.status === 404) {
    return 'That switch no longer exists.';
  }
  if (error instanceof ApiError && error.status === 429) {
    return 'Too many test releases. Try again later.';
  }
  return 'The test release could not be sent. Try again.';
}

export function TestRelease({ switchId }: { readonly switchId: string }) {
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [needsCode, setNeedsCode] = useState(false);
  const [totpCode, setTotpCode] = useState('');

  async function send(code?: string): Promise<void> {
    setMessage(null);
    setBusy(true);
    try {
      const result = await apiClient.request({
        method: 'POST',
        path: `/switches/${switchId}/test-release`,
        body: code === undefined ? {} : { totpCode: code },
        schema: testReleaseResponseSchema,
      });
      setNeedsCode(false);
      setMessage(
        result.channelCount === 1
          ? 'Test release sent to 1 channel. No real release happened.'
          : `Test release sent to ${result.channelCount} channels. No real release happened.`,
      );
    } catch (error) {
      if (error instanceof ApiError && error.status === 403) {
        setNeedsCode(true);
        setMessage('Enter your authenticator code to authorize the test release.');
      } else if (error instanceof ApiError && error.status === 502) {
        setMessage('Some test messages could not be delivered. Check a channel and try again.');
      } else {
        setMessage(errorMessage(error));
      }
    } finally {
      setBusy(false);
    }
  }

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    await send(needsCode ? totpCode : undefined);
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Test release</CardTitle>
        <CardDescription>
          Send a clearly-marked test message through every configured channel. Nothing is armed,
          released, or changed.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form className="space-y-4" onSubmit={event => void submit(event)} noValidate>
          {needsCode ? (
            <div className="space-y-2">
              <Label htmlFor="test-release-code">Authenticator code</Label>
              <Input
                id="test-release-code"
                value={totpCode}
                onChange={event => setTotpCode(event.currentTarget.value)}
                disabled={busy}
                inputMode="numeric"
                autoComplete="one-time-code"
                required
              />
            </div>
          ) : null}
          {message !== null ? (
            <p role="status" className="text-sm text-[var(--color-muted-foreground)]">
              {message}
            </p>
          ) : null}
          <Button type="submit" variant="outline" disabled={busy}>
            {busy ? 'Sending…' : 'Send test release'}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
