import { useState, type FormEvent } from 'react';
import { z } from 'zod';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { FieldGuidance } from '@/components/ui/field-guidance';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { apiClient, ApiError } from '@/lib/api-client';

const responseSchema = z.object({ ok: z.literal(true) });
const codeSchema = z.string().regex(/^\d{6,8}$/, 'Enter a 6–8 digit verification code.');

export function HeartbeatCheckin({
  switchId,
  active,
}: {
  readonly switchId: string;
  readonly active: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const form = event.currentTarget;
    const rawCode = new FormData(form).get('totpCode');
    const totpCode = typeof rawCode === 'string' && rawCode.length > 0 ? rawCode : undefined;
    if (totpCode !== undefined && !codeSchema.safeParse(totpCode).success) {
      setMessage('Enter a 6–8 digit verification code.');
      return;
    }
    setBusy(true);
    setMessage(null);
    try {
      await apiClient.request({
        method: 'POST',
        path: `/switches/${switchId}/check-in`,
        body: totpCode === undefined ? {} : { totpCode },
        schema: responseSchema,
      });
      setMessage('Check-in recorded. Your heartbeat deadline has been reset.');
      form.reset();
    } catch (error) {
      setMessage(
        error instanceof ApiError && error.status === 403
          ? 'A valid authenticator code is required for this check-in.'
          : error instanceof ApiError && error.status === 409
            ? 'This switch must be armed before you can check in.'
            : 'Check-in could not be recorded. Try again.',
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <Card>
      <CardHeader>
        <CardTitle>Check in</CardTitle>
        <CardDescription>
          Confirm that you are active and reset this switch&apos;s heartbeat deadline.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form className="space-y-4" onSubmit={submit} noValidate>
          <div className="space-y-2">
            <Label htmlFor="heartbeat-totp">Authenticator code (if enabled)</Label>
            <Input
              id="heartbeat-totp"
              name="totpCode"
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={8}
              disabled={!active || busy}
            />
            <FieldGuidance
              field="an authenticator code"
              description="Enter a TOTP code only when this account has two-factor authentication enabled."
              example="123456"
              result="The server verifies the code before recording this check-in."
            />
          </div>
          {message ? (
            <p role="status" className="text-sm text-[var(--color-muted-foreground)]">
              {message}
            </p>
          ) : null}
          <FieldGuidance
            field="checking in"
            description="A check-in confirms the owner is active and resets the heartbeat deadline to now plus its interval."
            example="Check in before a 7-day interval expires."
            result="The next deadline moves forward; leave the code blank unless the account has TOTP."
          />
          <Button type="submit" disabled={!active || busy}>
            {busy ? 'Recording check-in…' : 'Check in now'}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
