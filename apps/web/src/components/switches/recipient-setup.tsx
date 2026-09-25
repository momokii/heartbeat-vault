import { useState, type FormEvent } from 'react';
import { z } from 'zod';
import { FieldGuidance } from '@/components/ui/field-guidance';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { apiClient } from '@/lib/api-client';

const recipientSchema = z.object({
  channel: z.enum(['email', 'webhook', 'telegram']),
  address: z.string().trim().min(1).max(500),
});
const recipientResponseSchema = z.object({ id: z.string().uuid(), inviteToken: z.string().min(1) });
type DeliveryChannel = 'email' | 'webhook' | 'telegram';
type SubmitState = { readonly busy: boolean; readonly message: string | null };

export function RecipientSetup({
  switchId,
  disabled,
}: {
  readonly switchId: string;
  readonly disabled: boolean;
}) {
  const [state, setState] = useState<SubmitState>({ busy: false, message: null });
  const [inviteToken, setInviteToken] = useState<string | null>(null);
  const [channel, setChannel] = useState<DeliveryChannel>('email');

  async function addRecipient(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const form = event.currentTarget;
    const values = new FormData(form);
    const parsed = recipientSchema.safeParse({
      channel: values.get('channel'),
      address: values.get('address'),
    });
    if (!parsed.success) {
      setState({
        busy: false,
        message: parsed.error.issues[0]?.message ?? 'Check the recipient details.',
      });
      return;
    }
    setState({ busy: true, message: null });
    setInviteToken(null);
    try {
      const result = await apiClient.request({
        method: 'POST',
        path: `/switches/${switchId}/recipients`,
        body: parsed.data,
        schema: recipientResponseSchema,
      });
      setInviteToken(result.inviteToken);
      setState({
        busy: false,
        message: 'Recipient invited. Save the token below before leaving this page.',
      });
      form.reset();
    } catch {
      setState({ busy: false, message: 'The recipient could not be invited. Try again.' });
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Add recipient</CardTitle>
        <CardDescription>
          Recipients must accept their invitation before this switch can be armed.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form className="space-y-4" onSubmit={addRecipient} noValidate>
          <fieldset className="space-y-3">
            <legend className="text-sm font-medium">Delivery channel</legend>
            <label className="flex items-start gap-2 text-sm">
              <input
                type="radio"
                name="channel"
                value="email"
                checked={channel === 'email'}
                onChange={() => setChannel('email')}
                disabled={disabled}
              />
              <span className="font-medium">Email</span>
            </label>
            <FieldGuidance
              field="email delivery"
              description="Email sends a release notice to the recipient's mailbox. Delivery is at-least-once and the provider receipt is stored."
              example="recipient@example.com"
            />
            <label className="flex items-start gap-2 text-sm">
              <input
                type="radio"
                name="channel"
                value="webhook"
                checked={channel === 'webhook'}
                onChange={() => setChannel('webhook')}
                disabled={disabled}
              />
              <span className="font-medium">Webhook</span>
            </label>
            <FieldGuidance
              field="webhook delivery"
              description="Webhook sends a signed release notice to an HTTPS endpoint. Delivery is at-least-once and the endpoint receipt is stored."
              example="https://hooks.example.com/heartbeat"
            />
            <label className="flex items-start gap-2 text-sm">
              <input
                type="radio"
                name="channel"
                value="telegram"
                checked={channel === 'telegram'}
                onChange={() => setChannel('telegram')}
                disabled={disabled}
              />
              <span className="font-medium">Telegram</span>
            </label>
            <FieldGuidance
              field="telegram delivery"
              description="Telegram sends a release notice to a chat ID. Delivery is at-least-once and the Bot API receipt is stored."
              example="-1001234567890"
            />
          </fieldset>
          <div className="space-y-2">
            <label htmlFor="recipient-address" className="text-sm font-medium">
              Address
            </label>
            <Input
              id="recipient-address"
              name="address"
              required
              maxLength={500}
              disabled={disabled}
            />
            <FieldGuidance
              field="the delivery address"
              description="This is where the selected channel sends its release notice; the invitation must be accepted before arming."
              example="recipient@example.com, https://hooks.example.com/heartbeat, or -1001234567890"
            />
          </div>
          <FieldGuidance
            field="a recipient invitation"
            description="An invitation asks a recipient to accept this switch and its delivery channel before it can be armed."
            example="Share the one-time invitation token with recipient@example.com through a secure channel."
          />
          {state.message ? (
            <p role="status" className="text-sm text-[var(--color-muted-foreground)]">
              {state.message}
            </p>
          ) : null}
          {inviteToken ? (
            <p className="break-all rounded-md border p-3 font-mono text-xs" role="alert">
              Invitation token — copy and share it securely now: {inviteToken}
            </p>
          ) : null}
          <Button type="submit" disabled={disabled || state.busy}>
            {state.busy ? 'Creating invitation…' : 'Create invitation'}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
