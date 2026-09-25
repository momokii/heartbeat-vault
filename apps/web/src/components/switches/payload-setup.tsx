import { useState, type FormEvent } from 'react';
import { z } from 'zod';
import { FieldGuidance } from '@/components/ui/field-guidance';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { apiClient } from '@/lib/api-client';

const payloadSchema = z.object({
  plaintext: z.string().min(1, 'Enter a payload to seal.').max(1_000_000),
});
const payloadResponseSchema = z.object({ storedBytes: z.number().int().nonnegative() });
type SubmitState = { readonly busy: boolean; readonly message: string | null };

export function PayloadSetup({
  switchId,
  disabled,
}: {
  readonly switchId: string;
  readonly disabled: boolean;
}) {
  const [state, setState] = useState<SubmitState>({ busy: false, message: null });

  async function storePayload(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const form = event.currentTarget;
    const parsed = payloadSchema.safeParse({ plaintext: new FormData(form).get('plaintext') });
    if (!parsed.success) {
      setState({ busy: false, message: parsed.error.issues[0]?.message ?? 'Check the payload.' });
      return;
    }
    setState({ busy: true, message: null });
    try {
      const result = await apiClient.request({
        method: 'POST',
        path: `/switches/${switchId}/payload`,
        body: parsed.data,
        schema: payloadResponseSchema,
      });
      setState({
        busy: false,
        message: `Payload sealed and stored (${result.storedBytes} bytes).`,
      });
      form.reset();
    } catch {
      setState({ busy: false, message: 'The payload could not be sealed. Try again.' });
    }
  }

  return (
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
            <label htmlFor="payload" className="text-sm font-medium">
              Release payload
            </label>
            <textarea
              id="payload"
              name="plaintext"
              required
              disabled={disabled}
              className="min-h-32 w-full rounded-md border bg-transparent p-3 text-sm"
            />
            <FieldGuidance
              field="the release payload"
              description="The server performs envelope encryption before storage. It is immutable after release, must never contain an invitation token, and is limited to 1 MB."
              example="Instructions for accessing a separately stored encrypted archive."
              result="A sealed payload satisfies one arming prerequisite and is stored encrypted."
            />
          </div>
          {state.message ? (
            <p role="status" className="text-sm text-[var(--color-muted-foreground)]">
              {state.message}
            </p>
          ) : null}
          <FieldGuidance
            field="sealing the payload"
            description="This action sends the entered payload to the server for envelope encryption before storage."
            example="Seal a non-sensitive test message before relying on this switch."
            result="The stored ciphertext is available for the configured release path."
          />
          <Button type="submit" disabled={disabled || state.busy}>
            {state.busy ? 'Sealing payload…' : 'Seal and store payload'}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
