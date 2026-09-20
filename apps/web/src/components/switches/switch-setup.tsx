import { useState, type FormEvent } from 'react';
import { z } from 'zod';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { apiClient } from '@/lib/api-client';

const recipientSchema = z.object({
  channel: z.enum(['email', 'webhook', 'telegram']),
  address: z.string().trim().min(1).max(500),
});
const recipientResponseSchema = z.object({ id: z.string().uuid(), inviteToken: z.string().min(1) });
const payloadSchema = z.object({
  plaintext: z.string().min(1, 'Enter a payload to seal.').max(1_000_000),
});
const payloadResponseSchema = z.object({ storedBytes: z.number().int().nonnegative() });
type SubmitState = { readonly busy: boolean; readonly message: string | null };

export function SwitchSetup({
  switchId,
  disabled,
}: {
  readonly switchId: string;
  readonly disabled: boolean;
}) {
  const [recipient, setRecipient] = useState<SubmitState>({ busy: false, message: null });
  const [payload, setPayload] = useState<SubmitState>({ busy: false, message: null });
  const [inviteToken, setInviteToken] = useState<string | null>(null);
  async function addRecipient(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const form = event.currentTarget;
    const values = new FormData(form);
    const parsed = recipientSchema.safeParse({
      channel: values.get('channel'),
      address: values.get('address'),
    });
    if (!parsed.success) {
      setRecipient({
        busy: false,
        message: parsed.error.issues[0]?.message ?? 'Check the recipient details.',
      });
      return;
    }
    setRecipient({ busy: true, message: null });
    setInviteToken(null);
    try {
      const result = await apiClient.request({
        method: 'POST',
        path: `/switches/${switchId}/recipients`,
        body: parsed.data,
        schema: recipientResponseSchema,
      });
      setInviteToken(result.inviteToken);
      setRecipient({
        busy: false,
        message: 'Recipient invited. Save the token below before leaving this page.',
      });
      form.reset();
    } catch {
      setRecipient({ busy: false, message: 'The recipient could not be invited. Try again.' });
    }
  }
  async function storePayload(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const form = event.currentTarget;
    const values = new FormData(form);
    const parsed = payloadSchema.safeParse({ plaintext: values.get('plaintext') });
    if (!parsed.success) {
      setPayload({ busy: false, message: parsed.error.issues[0]?.message ?? 'Check the payload.' });
      return;
    }
    setPayload({ busy: true, message: null });
    try {
      const result = await apiClient.request({
        method: 'POST',
        path: `/switches/${switchId}/payload`,
        body: parsed.data,
        schema: payloadResponseSchema,
      });
      setPayload({
        busy: false,
        message: `Payload sealed and stored (${result.storedBytes} bytes).`,
      });
      form.reset();
    } catch {
      setPayload({ busy: false, message: 'The payload could not be sealed. Try again.' });
    }
  }
  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>Add recipient</CardTitle>
          <CardDescription>
            Recipients must accept their invitation before this switch can be armed.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form className="space-y-4" onSubmit={addRecipient} noValidate>
            <div className="space-y-2">
              <Label htmlFor="recipient-channel">Delivery channel</Label>
              <select
                id="recipient-channel"
                name="channel"
                className="flex h-9 w-full rounded-md border bg-transparent px-3 text-sm"
                defaultValue="email"
                disabled={disabled}
              >
                <option value="email">Email</option>
                <option value="webhook">Webhook</option>
                <option value="telegram">Telegram</option>
              </select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="recipient-address">Address</Label>
              <Input
                id="recipient-address"
                name="address"
                required
                maxLength={500}
                disabled={disabled}
              />
              <p className="text-xs text-[var(--color-muted-foreground)]">
                Use an email address, webhook URL, or Telegram chat ID for the selected channel.
              </p>
            </div>
            {recipient.message ? (
              <p role="status" className="text-sm text-[var(--color-muted-foreground)]">
                {recipient.message}
              </p>
            ) : null}
            {inviteToken ? (
              <p className="break-all rounded-md border p-3 font-mono text-xs" role="alert">
                Invitation token — copy and share it securely now: {inviteToken}
              </p>
            ) : null}
            <Button type="submit" disabled={disabled || recipient.busy}>
              {recipient.busy ? 'Creating invitation…' : 'Create invitation'}
            </Button>
          </form>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Seal payload</CardTitle>
          <CardDescription>
            The server encrypts this content before it is stored. It cannot be edited after release.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form className="space-y-4" onSubmit={storePayload} noValidate>
            <div className="space-y-2">
              <Label htmlFor="payload">Release payload</Label>
              <textarea
                id="payload"
                name="plaintext"
                required
                disabled={disabled}
                className="min-h-32 w-full rounded-md border bg-transparent p-3 text-sm"
              />
              <p className="text-xs text-[var(--color-muted-foreground)]">
                Do not include the invitation token here.
              </p>
            </div>
            {payload.message ? (
              <p role="status" className="text-sm text-[var(--color-muted-foreground)]">
                {payload.message}
              </p>
            ) : null}
            <Button type="submit" disabled={disabled || payload.busy}>
              {payload.busy ? 'Sealing payload…' : 'Seal and store payload'}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
