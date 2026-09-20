import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { z } from 'zod';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { apiClient, ApiError } from '@/lib/api-client';

const UserSchema = z.object({ id: z.string(), email: z.string().email(), role: z.string() });
const SwitchSchema = z.object({
  id: z.string().uuid(),
  title: z.string(),
  mode: z.string(),
  status: z.string(),
  heartbeatIntervalHours: z.number().int(),
  graceWindowHours: z.number().int(),
  dryRun: z.boolean(),
  releasePolicy: z.string(),
  heartbeatStartedAt: z.string().datetime().nullable(),
  nextDeadline: z.string().datetime().nullable(),
});
const SwitchesSchema = z.array(SwitchSchema);
type Switch = z.infer<typeof SwitchSchema>;
type DashboardState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'signed-out' }
  | { readonly kind: 'error' }
  | {
      readonly kind: 'ready';
      readonly email: string;
      readonly role: string;
      readonly switches: readonly Switch[];
    };

function statusLabel(status: string): string {
  return status === 'active' ? 'Active' : status === 'released' ? 'Released' : 'Paused';
}

function formatDeadline(deadline: string | null): string {
  if (!deadline) return 'No heartbeat deadline set';
  return `Next check-in: ${new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(deadline))}`;
}

export function HomePage() {
  const [state, setState] = useState<DashboardState>({ kind: 'loading' });

  useEffect(() => {
    const controller = new AbortController();
    async function load(): Promise<void> {
      try {
        const [user, switches] = await Promise.all([
          apiClient.request({ path: '/me', schema: UserSchema, signal: controller.signal }),
          apiClient.request({
            path: '/switches',
            schema: SwitchesSchema,
            signal: controller.signal,
          }),
        ]);
        setState({ kind: 'ready', email: user.email, role: user.role, switches });
      } catch (error) {
        if (controller.signal.aborted) return;
        setState({
          kind: error instanceof ApiError && error.status === 401 ? 'signed-out' : 'error',
        });
      }
    }
    void load();
    return () => controller.abort();
  }, []);

  if (state.kind === 'loading') {
    return <p className="text-sm text-[var(--color-muted-foreground)]">Loading your vault…</p>;
  }

  if (state.kind === 'signed-out') {
    return <Welcome title="Your heartbeat keeps the vault sealed." action="Sign in" to="/login" />;
  }

  if (state.kind === 'error') {
    return <Welcome title="Your vault is temporarily unavailable." action="Try again" to="/" />;
  }

  return (
    <div className="space-y-8">
      <section className="flex flex-wrap items-end justify-between gap-4">
        <div className="space-y-2">
          <p className="text-xs font-mono uppercase tracking-[0.18em] text-[var(--color-muted-foreground)]">
            Vault overview
          </p>
          <h1 className="text-3xl font-semibold tracking-tight">Your switches</h1>
          <p className="text-sm text-[var(--color-muted-foreground)]">Signed in as {state.email}</p>
        </div>
        <Link
          to="/switches/new"
          className="inline-flex h-9 items-center rounded-md bg-[var(--color-primary)] px-4 text-sm font-medium text-[var(--color-primary-foreground)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-ring)]"
        >
          Create switch
        </Link>
        {state.role === 'admin' ? (
          <Link to="/admin" className="text-sm font-medium underline underline-offset-4">
            Admin
          </Link>
        ) : null}
      </section>
      {state.switches.length === 0 ? (
        <Card>
          <CardHeader>
            <CardTitle>No switches yet</CardTitle>
            <CardDescription>
              Create a switch, add recipients and a sealed payload, then arm it when you are ready.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Link to="/switches/new" className="text-sm font-medium underline underline-offset-4">
              Create your first switch
            </Link>
          </CardContent>
        </Card>
      ) : (
        <section aria-label="Your switches" className="grid gap-4">
          {state.switches.map(switchItem => (
            <Card key={switchItem.id}>
              <CardHeader className="gap-2 sm:flex-row sm:items-start sm:justify-between">
                <div>
                  <CardTitle>{switchItem.title}</CardTitle>
                  <CardDescription>
                    {switchItem.mode === 'asymmetric_key' ? 'Key release' : 'Direct delivery'} ·{' '}
                    {switchItem.heartbeatIntervalHours}h interval
                  </CardDescription>
                </div>
                <span className="rounded-full border px-2 py-0.5 text-xs font-medium">
                  {statusLabel(switchItem.status)}
                </span>
              </CardHeader>
              <CardContent className="flex flex-wrap items-center justify-between gap-3 text-sm text-[var(--color-muted-foreground)]">
                <span>{formatDeadline(switchItem.nextDeadline)}</span>
                <Link
                  to={`/switches/${switchItem.id}`}
                  className="font-medium text-[var(--color-foreground)] underline underline-offset-4"
                >
                  Manage switch
                </Link>
              </CardContent>
            </Card>
          ))}
        </section>
      )}
    </div>
  );
}

function Welcome({
  title,
  action,
  to,
}: {
  readonly title: string;
  readonly action: string;
  readonly to: string;
}) {
  return (
    <section className="max-w-3xl space-y-4">
      <p className="text-xs font-mono uppercase tracking-[0.18em] text-[var(--color-muted-foreground)]">
        Dead man&apos;s switch — self-hosted
      </p>
      <h1 className="text-3xl sm:text-4xl font-semibold tracking-tight leading-[1.1]">{title}</h1>
      <p className="max-w-[65ch] text-base leading-relaxed text-[var(--color-muted-foreground)]">
        Heartbeat Vault holds encrypted payloads until a missed check-in, fixed date, or panic
        trigger releases them. Your data stays on hardware you control.
      </p>
      <Link
        to={to}
        className="inline-flex h-9 items-center rounded-md bg-[var(--color-primary)] px-4 text-sm font-medium text-[var(--color-primary-foreground)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-ring)]"
      >
        {action}
      </Link>
    </section>
  );
}
