import { useEffect, useState, type FormEvent } from 'react';
import { z } from 'zod';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ApiError, apiClient } from '@/lib/api-client';

const delegateSchema = z.object({
  id: z.string().uuid(),
  email: z.string().email(),
  createdAt: z.string().datetime(),
});
const delegatesSchema = z.array(delegateSchema);
const grantResponseSchema = z.object({
  id: z.string().uuid(),
  delegateUserId: z.string().uuid(),
  createdAt: z.string().datetime(),
});
const revokeResponseSchema = z.object({ ok: z.literal(true) });
const emailSchema = z.string().trim().email('Enter a valid email address.');
type Delegate = z.infer<typeof delegateSchema>;
type ListState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'ready'; readonly items: readonly Delegate[] }
  | { readonly kind: 'error' };

function formatDate(value: string): string {
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(new Date(value));
}

function errorMessage(error: unknown, action: 'grant' | 'revoke'): string {
  if (error instanceof ApiError && error.status === 409 && action === 'grant') {
    return 'That user is already a delegate for this switch.';
  }
  if (error instanceof ApiError && error.status === 404) {
    return action === 'grant'
      ? 'No registered user was found with that email address.'
      : 'That delegate is no longer assigned to this switch.';
  }
  return action === 'grant'
    ? 'The delegate could not be added. Try again.'
    : 'The delegate could not be revoked. Try again.';
}

export function TrustedDelegates({ switchId }: { readonly switchId: string }) {
  const [listState, setListState] = useState<ListState>({ kind: 'loading' });
  const [email, setEmail] = useState('');
  const [formMessage, setFormMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState<Delegate | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    apiClient
      .request({
        path: `/switches/${switchId}/delegates`,
        schema: delegatesSchema,
        signal: controller.signal,
      })
      .then(items => {
        if (!controller.signal.aborted) setListState({ kind: 'ready', items });
      })
      .catch(error => {
        if (!controller.signal.aborted) {
          if (error instanceof ApiError) setListState({ kind: 'error' });
          else throw error;
        }
      });
    return () => controller.abort();
  }, [switchId]);

  async function grant(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const parsed = emailSchema.safeParse(email);
    if (!parsed.success) {
      setFormMessage(parsed.error.issues[0]?.message ?? 'Enter a valid email address.');
      return;
    }
    setBusy(true);
    setFormMessage(null);
    try {
      const result = await apiClient.request({
        method: 'POST',
        path: `/switches/${switchId}/delegates`,
        body: { email: parsed.data },
        schema: grantResponseSchema,
      });
      setListState(current =>
        current.kind === 'ready'
          ? {
              kind: 'ready',
              items: [
                ...current.items,
                { id: result.id, email: parsed.data, createdAt: result.createdAt },
              ],
            }
          : current,
      );
      setEmail('');
      setFormMessage('Delegate added.');
    } catch (error) {
      setFormMessage(errorMessage(error, 'grant'));
    } finally {
      setBusy(false);
    }
  }

  async function revoke(delegate: Delegate): Promise<void> {
    setBusy(true);
    setFormMessage(null);
    setConfirming(null);
    try {
      await apiClient.request({
        method: 'DELETE',
        path: `/switches/${switchId}/delegates/${delegate.id}`,
        schema: revokeResponseSchema,
      });
      setListState(current =>
        current.kind === 'ready'
          ? { kind: 'ready', items: current.items.filter(item => item.id !== delegate.id) }
          : current,
      );
      setFormMessage('Delegate revoked.');
    } catch (error) {
      setFormMessage(errorMessage(error, 'revoke'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Delegates</CardTitle>
        <CardDescription>
          Trusted delegates can pause this switch and cancel a pending release. They cannot change
          its settings or access its payload.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {listState.kind === 'loading' ? (
          <p className="text-sm text-[var(--color-muted-foreground)]">Loading delegates…</p>
        ) : listState.kind === 'error' ? (
          <p role="alert" className="text-sm text-[var(--color-destructive)]">
            Delegates could not be loaded. Try refreshing the page.
          </p>
        ) : listState.items.length === 0 ? (
          <p className="text-sm text-[var(--color-muted-foreground)]">No delegates assigned.</p>
        ) : (
          <ul className="divide-y rounded-md border">
            {listState.items.map(delegate => (
              <li
                key={delegate.id}
                className="flex flex-wrap items-center justify-between gap-3 px-3 py-3 text-sm"
              >
                <div>
                  <p className="font-medium">{delegate.email}</p>
                  <p className="text-xs text-[var(--color-muted-foreground)]">
                    Since {formatDate(delegate.createdAt)}
                  </p>
                </div>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={busy}
                  onClick={() => setConfirming(delegate)}
                >
                  Revoke
                </Button>
              </li>
            ))}
          </ul>
        )}
        <form className="space-y-3 border-t pt-4" onSubmit={grant} noValidate>
          <div className="space-y-2">
            <Label htmlFor="delegate-email">Delegate email</Label>
            <Input
              id="delegate-email"
              name="email"
              type="email"
              autoComplete="email"
              value={email}
              onChange={event => setEmail(event.target.value)}
              disabled={busy}
              aria-describedby={formMessage ? 'delegate-message' : undefined}
              required
            />
          </div>
          {formMessage ? (
            <p
              id="delegate-message"
              role="status"
              className="text-sm text-[var(--color-muted-foreground)]"
            >
              {formMessage}
            </p>
          ) : null}
          <Button type="submit" disabled={busy}>
            {busy ? 'Saving…' : 'Grant delegate access'}
          </Button>
        </form>
      </CardContent>
      {confirming ? (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
          onClick={() => setConfirming(null)}
        >
          <div
            role="alertdialog"
            aria-modal="true"
            aria-label={`Confirm revoking ${confirming.email}`}
            className="w-full max-w-md space-y-3 rounded-lg border bg-[var(--color-background)] p-5"
            onClick={event => event.stopPropagation()}
          >
            <p className="text-base font-semibold">Revoke {confirming.email}?</p>
            <p className="text-sm text-[var(--color-muted-foreground)]">
              This immediately removes their pause and cancellation access.
            </p>
            <div className="flex justify-end gap-2">
              <Button type="button" variant="outline" onClick={() => setConfirming(null)}>
                Keep delegate
              </Button>
              <Button type="button" variant="destructive" onClick={() => void revoke(confirming)}>
                Revoke access
              </Button>
            </div>
          </div>
        </div>
      ) : null}
    </Card>
  );
}
