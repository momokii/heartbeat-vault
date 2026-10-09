import { useState } from 'react';
import type { ReactNode } from 'react';
import { z } from 'zod';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { apiClient, ApiError } from '@/lib/api-client';

const BulkCheckInResultSchema = z.object({
  switchId: z.string().uuid(),
  ok: z.boolean(),
  error: z.string().optional(),
});
const BulkCheckInResultsSchema = z.array(BulkCheckInResultSchema);

type BulkCheckInSwitch = {
  readonly id: string;
  readonly title: string;
};
type BulkCheckInResult = z.infer<typeof BulkCheckInResultSchema>;
type BulkCheckInState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'confirming' }
  | { readonly kind: 'submitting' }
  | { readonly kind: 'results'; readonly results: readonly BulkCheckInResult[] }
  | { readonly kind: 'error'; readonly message: string };

type BulkCheckInProps = {
  readonly switches: readonly BulkCheckInSwitch[];
};

function requestErrorMessage(error: unknown): string {
  if (!(error instanceof ApiError)) return 'The bulk check-in could not be completed. Try again.';
  if (error.status === 403) return 'Enter a current authenticator code and try again.';
  if (error.status === 400)
    return 'The check-in request was invalid. Refresh the page and try again.';
  if (error.status === 429) return 'Too many attempts. Wait a moment before trying again.';
  return 'The bulk check-in could not be completed. Try again.';
}

function resultMessage(result: BulkCheckInResult): string {
  if (result.ok) return 'Checked in';
  if (result.error === 'not_found') return 'Switch is no longer active or could not be found.';
  return 'This switch could not be checked in.';
}

export function BulkCheckIn({ switches }: BulkCheckInProps) {
  const [state, setState] = useState<BulkCheckInState>({ kind: 'idle' });
  const [totpCode, setTotpCode] = useState('');

  if (switches.length === 0) return null;

  const isSubmitting = state.kind === 'submitting';
  const successfulCount =
    state.kind === 'results' ? state.results.filter(result => result.ok).length : 0;

  async function submit(): Promise<void> {
    setState({ kind: 'submitting' });
    try {
      const results = await apiClient.request({
        method: 'POST',
        path: '/switches/check-in/all',
        body: {
          switchIds: switches.map(item => item.id),
          ...(totpCode.trim() ? { totpCode: totpCode.trim() } : {}),
        },
        schema: BulkCheckInResultsSchema,
      });
      setState({ kind: 'results', results });
      setTotpCode('');
    } catch (error) {
      setState({ kind: 'error', message: requestErrorMessage(error) });
    }
  }

  return (
    <CardSection
      count={switches.length}
      isSubmitting={isSubmitting}
      onOpen={() => setState({ kind: 'confirming' })}
    >
      {state.kind === 'results' ? (
        <div className="space-y-3" role="status" aria-live="polite">
          <p className="text-sm font-medium">
            {successfulCount === switches.length
              ? 'All active switches checked in.'
              : `Partial success: ${successfulCount} of ${switches.length} switches checked in.`}
          </p>
          <ul className="divide-y rounded-md border">
            {switches.map(switchItem => {
              const result = state.results.find(item => item.switchId === switchItem.id);
              return (
                <li
                  key={switchItem.id}
                  className="flex min-w-0 flex-wrap items-baseline justify-between gap-2 px-3 py-2 text-sm"
                >
                  <span className="min-w-0 break-words font-medium">{switchItem.title}</span>
                  <span
                    className={
                      result?.ok ? 'text-[var(--color-primary)]' : 'text-[var(--color-destructive)]'
                    }
                  >
                    {result ? resultMessage(result) : 'No result returned.'}
                  </span>
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}
      {state.kind === 'error' ? (
        <p role="alert" className="text-sm text-[var(--color-destructive)]">
          {state.message}
        </p>
      ) : null}
      <Dialog
        open={state.kind === 'confirming' || state.kind === 'submitting'}
        onOpenChange={open => {
          if (!open && !isSubmitting) setState({ kind: 'idle' });
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Check in all active switches?</DialogTitle>
            <DialogDescription>
              This will record a heartbeat for {switches.length} active switch
              {switches.length === 1 ? '' : 'es'}. Confirm only if you are ready to extend all of
              their deadlines.
            </DialogDescription>
          </DialogHeader>
          <div className="mt-6 space-y-2">
            <Label htmlFor="bulk-check-in-totp">Authenticator code (if enabled)</Label>
            <Input
              id="bulk-check-in-totp"
              inputMode="numeric"
              autoComplete="one-time-code"
              value={totpCode}
              onChange={event => setTotpCode(event.currentTarget.value)}
              disabled={isSubmitting}
              placeholder="6-digit code"
            />
            <p className="text-xs text-[var(--color-muted-foreground)]">
              Two-factor authentication may require a current code to check in all switches.
            </p>
          </div>
          <div className="mt-6 flex flex-wrap justify-end gap-2">
            <Button
              type="button"
              variant="outline"
              disabled={isSubmitting}
              onClick={() => setState({ kind: 'idle' })}
            >
              Cancel
            </Button>
            <Button type="button" disabled={isSubmitting} onClick={() => void submit()}>
              {isSubmitting ? 'Checking in…' : 'Confirm check in'}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </CardSection>
  );
}

type CardSectionProps = {
  readonly count: number;
  readonly isSubmitting: boolean;
  readonly onOpen: () => void;
  readonly children: ReactNode;
};

function CardSection({ count, isSubmitting, onOpen, children }: CardSectionProps) {
  return (
    <section className="rounded-md border p-4" aria-label="Bulk check-in">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-base font-semibold">Bulk check-in</h2>
          <p className="text-sm text-[var(--color-muted-foreground)]">
            Record a heartbeat for all {count} active switch{count === 1 ? '' : 'es'} at once.
          </p>
        </div>
        <Button type="button" onClick={onOpen} disabled={isSubmitting}>
          Check in all
        </Button>
      </div>
      <div className="mt-4 space-y-3">{children}</div>
    </section>
  );
}
