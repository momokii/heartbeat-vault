import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { z } from 'zod';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { apiClient, ApiError } from '@/lib/api-client';

const userSchema = z.object({
  id: z.string().uuid(),
  email: z.string().email(),
  role: z.string(),
  created_at: z.string(),
});
const usersSchema = z.array(userSchema);
const inviteSchema = z.object({ id: z.string().uuid(), token: z.string().min(1) });
const inviteFormSchema = z.object({
  email: z.string().email('Enter a valid email address.'),
  role: z.enum(['user', 'admin']),
});
type PageState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'forbidden' }
  | { readonly kind: 'error' }
  | { readonly kind: 'ready'; readonly users: readonly z.infer<typeof userSchema>[] };
type InviteResult =
  | { readonly kind: 'idle' }
  | { readonly kind: 'success'; readonly token: string }
  | { readonly kind: 'error'; readonly message: string };

export function AdminPage() {
  const [state, setState] = useState<PageState>({ kind: 'loading' });
  const [busy, setBusy] = useState(false);
  const [inviteResult, setInviteResult] = useState<InviteResult>({ kind: 'idle' });
  const loadUsers = useCallback(async (signal?: AbortSignal): Promise<void> => {
    try {
      const users = await apiClient.request({
        path: '/users',
        schema: usersSchema,
        signal,
      });
      setState({ kind: 'ready', users });
    } catch (error) {
      if (!signal?.aborted)
        setState(
          error instanceof ApiError && (error.status === 401 || error.status === 403)
            ? { kind: 'forbidden' }
            : { kind: 'error' },
        );
    }
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    void loadUsers(controller.signal);
    return () => controller.abort();
  }, [loadUsers]);
  async function createInvite(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const formElement = event.currentTarget;
    const form = new FormData(event.currentTarget);
    const parsed = inviteFormSchema.safeParse({ email: form.get('email'), role: form.get('role') });
    if (!parsed.success) {
      setInviteResult({
        kind: 'error',
        message: parsed.error.issues[0]?.message ?? 'Check the invitation details.',
      });
      return;
    }
    setBusy(true);
    setInviteResult({ kind: 'idle' });
    try {
      const result = await apiClient.request({
        method: 'POST',
        path: '/invites',
        body: parsed.data,
        schema: inviteSchema,
      });
      setInviteResult({ kind: 'success', token: result.token });
      formElement.reset();
      void loadUsers();
    } catch {
      setInviteResult({
        kind: 'error',
        message: 'The invitation could not be created. Try again.',
      });
    } finally {
      setBusy(false);
    }
  }
  if (state.kind === 'loading')
    return <p className="text-sm text-[var(--color-muted-foreground)]">Loading administration…</p>;
  if (state.kind === 'forbidden')
    return (
      <section className="space-y-4">
        <h1 className="text-2xl font-semibold">Administrator access required</h1>
        <Link to="/" className="text-sm font-medium underline underline-offset-4">
          Return to dashboard
        </Link>
      </section>
    );
  if (state.kind === 'error')
    return (
      <section className="space-y-4">
        <h1 className="text-2xl font-semibold">Administration unavailable</h1>
        <Link to="/" className="text-sm font-medium underline underline-offset-4">
          Return to dashboard
        </Link>
      </section>
    );
  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <Link to="/" className="text-sm font-medium underline underline-offset-4">
        ← Dashboard
      </Link>
      <div className="space-y-2">
        <p className="text-xs font-mono uppercase tracking-[0.18em] text-[var(--color-muted-foreground)]">
          Administration
        </p>
        <h1 className="text-2xl font-semibold tracking-tight">Users and invitations</h1>
      </div>
      <Card>
        <CardHeader>
          <CardTitle>Invite a user</CardTitle>
          <CardDescription>
            Invitation tokens are returned once and expire after 24 hours. The new user can open
            /invite/accept to confirm their new account.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form className="space-y-4" onSubmit={createInvite} noValidate>
            <div className="space-y-2">
              <Label htmlFor="invite-email">Email address</Label>
              <Input id="invite-email" name="email" type="email" required disabled={busy} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="invite-role">Role</Label>
              <select
                id="invite-role"
                name="role"
                defaultValue="user"
                disabled={busy}
                className="flex h-9 w-full rounded-md border bg-transparent px-3 text-sm"
              >
                <option value="user">User</option>
                <option value="admin">Administrator</option>
              </select>
            </div>
            {inviteResult.kind === 'success' ? (
              <p role="status" className="text-sm text-[var(--color-muted-foreground)]">
                Invitation created. Copy the token before leaving this page. The new user can open
                /invite/accept to confirm their new account.
              </p>
            ) : null}
            {inviteResult.kind === 'success' ? (
              <div className="space-y-2 rounded-md border p-3">
                <p className="break-all font-mono text-xs">
                  Invitation token — copy and share securely now: {inviteResult.token}
                </p>
                <p className="break-all text-xs text-[var(--color-muted-foreground)]">
                  Accept link: {window.location.origin}/invite/accept?token={inviteResult.token}
                </p>
                <Link
                  to={`/invite/accept?token=${encodeURIComponent(inviteResult.token)}`}
                  className="text-xs font-medium underline underline-offset-4"
                >
                  Open the accept-invitation page
                </Link>
              </div>
            ) : null}
            {inviteResult.kind === 'error' ? (
              <p role="alert" className="text-sm text-[var(--color-muted-foreground)]">
                {inviteResult.message}
              </p>
            ) : null}
            <Button type="submit" disabled={busy}>
              {busy ? 'Creating invitation…' : 'Create invitation'}
            </Button>
          </form>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Users</CardTitle>
          <CardDescription>
            {state.users.length} registered account{state.users.length === 1 ? '' : 's'}.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ul className="divide-y">
            <li className="sr-only">Registered users</li>
            {state.users.map(user => (
              <li
                key={user.id}
                className="flex flex-wrap items-center justify-between gap-2 py-3 text-sm"
              >
                <span>{user.email}</span>
                <span className="rounded-full border px-2 py-0.5 text-xs">{user.role}</span>
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>
    </div>
  );
}
