import { useState, type FormEvent } from 'react';
import { z } from 'zod';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { FieldGuidance } from '@/components/ui/field-guidance';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { apiClient } from '@/lib/api-client';

const responseSchema = z.object({
  ok: z.literal(true),
  triggerType: z.enum(['fixed_date', 'panic', 'quorum']),
});
const thresholdSchema = z.coerce.number().int().min(2).max(255);
type TriggerKind = 'fixed_date' | 'quorum' | 'panic';

export function TriggerConfiguration({
  switchId,
  disabled,
}: {
  readonly switchId: string;
  readonly disabled: boolean;
}) {
  const [kind, setKind] = useState<TriggerKind>('fixed_date');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [panicConfirmed, setPanicConfirmed] = useState(false);
  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const values = new FormData(event.currentTarget);
    let body: {
      readonly type: TriggerKind;
      readonly fireAt?: string;
      readonly threshold?: number;
      readonly confirm?: true;
    };
    if (kind === 'fixed_date') {
      const localDate = values.get('fireAt');
      if (typeof localDate !== 'string' || !localDate) {
        setMessage('Choose a future date and time.');
        return;
      }
      const date = new Date(localDate);
      if (Number.isNaN(date.getTime()) || date.getTime() <= Date.now()) {
        setMessage('Choose a future date and time.');
        return;
      }
      body = { type: 'fixed_date', fireAt: date.toISOString() };
    } else if (kind === 'quorum') {
      const parsed = thresholdSchema.safeParse(values.get('threshold'));
      if (!parsed.success) {
        setMessage('Choose a quorum threshold of at least two recipients.');
        return;
      }
      body = { type: 'quorum', threshold: parsed.data };
    } else {
      if (!panicConfirmed) {
        setMessage('Confirm the immediate panic trigger before continuing.');
        return;
      }
      body = { type: 'panic', confirm: true };
    }
    setBusy(true);
    setMessage(null);
    try {
      const result = await apiClient.request({
        method: 'POST',
        path: `/switches/${switchId}/trigger`,
        body,
        schema: responseSchema,
      });
      setMessage(
        result.triggerType === 'panic'
          ? 'Panic trigger configured. The release workflow is now pending its cancellation window.'
          : `${result.triggerType === 'fixed_date' ? 'Fixed-date' : 'Quorum'} trigger configured.`,
      );
    } catch {
      setMessage('The trigger could not be configured. Check the switch and try again.');
    } finally {
      setBusy(false);
    }
  }
  return (
    <Card>
      <CardHeader>
        <CardTitle>Trigger configuration</CardTitle>
        <CardDescription>
          Choose a non-heartbeat condition that can start this switch&apos;s release workflow.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form className="space-y-4" onSubmit={submit} noValidate>
          <fieldset className="space-y-2">
            <legend className="text-sm font-medium">Trigger type</legend>
            <label className="flex gap-2 text-sm">
              <input
                type="radio"
                name="kind"
                checked={kind === 'fixed_date'}
                onChange={() => setKind('fixed_date')}
                disabled={disabled || busy}
              />{' '}
              Fixed date and time
            </label>
            <FieldGuidance
              field="the fixed-date trigger"
              description="This trigger fires at an exact UTC time, so the selected date and time must be in the future."
              example="2030-01-02 03:04 in your local time."
              result="Fires at that exact UTC time after the local entry is converted to ISO."
            />
            <label className="flex gap-2 text-sm">
              <input
                type="radio"
                name="kind"
                checked={kind === 'quorum'}
                onChange={() => setKind('quorum')}
                disabled={disabled || busy}
              />{' '}
              Recipient quorum
            </label>
            <FieldGuidance
              field="the quorum trigger"
              description="Quorum is event-driven: release starts after t-of-n recipients record deceased votes. The threshold must be at least two."
              example="2 votes from 3 eligible recipients."
              result="Release starts only when the required deceased-vote threshold is reached."
            />
            <label className="flex gap-2 text-sm">
              <input
                type="radio"
                name="kind"
                checked={kind === 'panic'}
                onChange={() => setKind('panic')}
                disabled={disabled || busy}
              />{' '}
              Panic trigger
            </label>
            <FieldGuidance
              field="the panic trigger"
              description="Panic starts release immediately, subject to the switch cancellation window, and requires acknowledgement."
              example="Use after a verified emergency requiring immediate release."
              result="The release workflow starts now and remains cancellable during its window."
            />
          </fieldset>
          {kind === 'fixed_date' ? (
            <div className="space-y-2">
              <Label htmlFor="fire-at">Fire at</Label>
              <Input
                id="fire-at"
                name="fireAt"
                type="datetime-local"
                disabled={disabled || busy}
                required
              />
              <FieldGuidance
                field="the fire time"
                description="This local date-and-time input is converted to an ISO timestamp before it is sent."
                example="2030-01-02 03:04 local time."
                result="The fixed-date trigger fires at the corresponding exact UTC time."
              />
            </div>
          ) : null}
          {kind === 'quorum' ? (
            <div className="space-y-2">
              <Label htmlFor="threshold">Required recipient votes</Label>
              <Input
                id="threshold"
                name="threshold"
                type="number"
                min="2"
                max="255"
                defaultValue="2"
                disabled={disabled || busy}
                required
              />
              <FieldGuidance
                field="required recipient votes"
                description="Choose the number of deceased votes needed to satisfy the event-driven quorum trigger."
                example="2"
                result="At least two recipient votes are required before release can start."
              />
            </div>
          ) : null}
          {kind === 'panic' ? (
            <div className="space-y-2">
              <label className="flex gap-2 rounded-md border border-[var(--color-destructive)] p-3 text-sm">
                <input
                  type="checkbox"
                  checked={panicConfirmed}
                  onChange={event => setPanicConfirmed(event.target.checked)}
                  disabled={disabled || busy}
                />{' '}
                I understand this begins the release workflow immediately, subject to the
                cancellation window.
              </label>
              <FieldGuidance
                field="the panic acknowledgement"
                description="This checkbox is the explicit acknowledgement required before configuring a panic trigger."
                example="Check it only after reviewing the cancellation window."
                result="The panic request can be submitted with its required confirmation."
              />
            </div>
          ) : null}
          {message ? (
            <p role="status" className="text-sm text-[var(--color-muted-foreground)]">
              {message}
            </p>
          ) : null}
          <FieldGuidance
            field={kind === 'panic' ? 'starting a panic release' : 'saving this trigger'}
            description="This action submits only the selected trigger configuration to the existing switch endpoint."
            example={
              kind === 'panic'
                ? 'Submit an acknowledged panic trigger.'
                : 'Save a future fixed date.'
            }
            result={
              kind === 'panic'
                ? 'Release starts subject to cancellation.'
                : 'The chosen trigger replaces the switch trigger configuration.'
            }
          />
          <Button
            type="submit"
            variant={kind === 'panic' ? 'destructive' : 'default'}
            disabled={disabled || busy || (kind === 'panic' && !panicConfirmed)}
          >
            {busy ? 'Saving trigger…' : kind === 'panic' ? 'Trigger panic release' : 'Save trigger'}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
