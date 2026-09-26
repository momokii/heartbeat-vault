import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { z } from 'zod';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
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
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  ownerEmail: z.string().email().nullable().optional(),
});
const SwitchesSchema = z.array(SwitchSchema);
const StatusFilterSchema = z.enum(['all', 'active', 'paused', 'released']);
const statusFilterOptions = [
  { value: 'all', label: 'All' },
  { value: 'active', label: 'Active' },
  { value: 'paused', label: 'Paused' },
  { value: 'released', label: 'Released' },
] as const;
const dateTimeFormatter = new Intl.DateTimeFormat(undefined, {
  dateStyle: 'medium',
  timeStyle: 'short',
});
type Switch = z.infer<typeof SwitchSchema>;
type StatusFilter = z.infer<typeof StatusFilterSchema>;
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
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');

  useEffect(() => {
    const controller = new AbortController();
    async function load(): Promise<void> {
      try {
        const [user, switches] = await Promise.all([
          apiClient.request({ path: '/me', schema: UserSchema, signal: controller.signal }),
          apiClient.request({
            path: '/switches?all=1',
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

  const normalizedSearch = search.trim().toLocaleLowerCase();
  const visibleSwitches = state.switches.filter(
    switchItem =>
      switchItem.title.toLocaleLowerCase().includes(normalizedSearch) &&
      (statusFilter === 'all' || switchItem.status === statusFilter),
  );

  return (
    <div className="space-y-8">
      <section className="flex flex-wrap items-end justify-between gap-4">
        <div className="space-y-2">
          <p className="text-xs font-mono uppercase tracking-[0.18em] text-[var(--color-muted-foreground)]">
            Vault overview
          </p>
          <h1 className="text-3xl font-semibold tracking-tight">Your switches</h1>
          <p className="text-sm text-[var(--color-muted-foreground)]">
            Signed in as {state.email}
            {state.role === 'admin' ? (
              <>
                {' · '}
                <Link to="/admin" className="font-medium underline underline-offset-4">
                  Admin
                </Link>
              </>
            ) : null}
          </p>
        </div>
        <Link
          to="/switches/new"
          className="inline-flex h-9 items-center rounded-md bg-[var(--color-primary)] px-4 text-sm font-medium text-[var(--color-primary-foreground)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-ring)]"
        >
          Create switch
        </Link>
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
        <>
          <section
            aria-label="Filter switches"
            className="grid gap-4 rounded-md border p-4 sm:grid-cols-2"
          >
            <div className="space-y-2">
              <Label htmlFor="switch-search">Search switches</Label>
              <Input
                id="switch-search"
                type="search"
                value={search}
                onChange={event => setSearch(event.target.value)}
                placeholder="Search by title"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="switch-status">Status</Label>
              <select
                id="switch-status"
                value={statusFilter}
                onChange={event => {
                  const parsed = StatusFilterSchema.safeParse(event.target.value);
                  if (parsed.success) setStatusFilter(parsed.data);
                }}
                className="flex h-9 w-full rounded-md border bg-transparent px-3 text-sm"
              >
                {statusFilterOptions.map(option => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </div>
          </section>
          {visibleSwitches.length === 0 ? (
            <Card>
              <CardHeader>
                <CardTitle>No switches match your filters.</CardTitle>
                <CardDescription>Try a different title or status.</CardDescription>
              </CardHeader>
            </Card>
          ) : (
            <section aria-label="Your switches" className="grid gap-4">
              {visibleSwitches.map(switchItem => (
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
                  <CardContent className="flex flex-wrap items-start justify-between gap-3 text-sm text-[var(--color-muted-foreground)]">
                    <div className="space-y-1">
                      <p>{formatDeadline(switchItem.nextDeadline)}</p>
                      <p>Created: {dateTimeFormatter.format(new Date(switchItem.createdAt))}</p>
                      <p>Updated: {dateTimeFormatter.format(new Date(switchItem.updatedAt))}</p>
                      {state.role === 'admin' && switchItem.ownerEmail ? (
                        <p>Owner: {switchItem.ownerEmail}</p>
                      ) : null}
                    </div>
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
        </>
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
