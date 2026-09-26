import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { z } from 'zod';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ApiError, apiClient } from '@/lib/api-client';

const activityItemSchema = z.object({
  id: z.number().int().positive(),
  timestamp: z.string().datetime(),
  actorId: z.string().nullable(),
  actorEmail: z.string().email().nullable(),
  action: z.string(),
  target: z.string().nullable(),
});
const activityResponseSchema = z.object({
  items: z.array(activityItemSchema),
  nextBeforeId: z.number().int().positive().nullable(),
});

type ActivityItem = z.infer<typeof activityItemSchema>;
type ActivityFilters = { readonly action: string; readonly query: string };
type ActivityState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'forbidden' }
  | { readonly kind: 'error' }
  | {
      readonly kind: 'ready';
      readonly items: readonly ActivityItem[];
      readonly nextBeforeId: number | null;
      readonly isLoadingMore: boolean;
    };

const EMPTY_FILTERS: ActivityFilters = { action: '', query: '' };

function formatActivityTime(timestamp: string): string {
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(
    new Date(timestamp),
  );
}

function actorLabel(item: ActivityItem): string {
  return item.actorEmail ?? item.actorId ?? 'System';
}

export function AdminActivityPage() {
  const [filters, setFilters] = useState<ActivityFilters>(EMPTY_FILTERS);
  const [state, setState] = useState<ActivityState>({ kind: 'loading' });

  const loadFirstPage = useCallback(
    async (nextFilters: ActivityFilters, signal?: AbortSignal): Promise<void> => {
      setState({ kind: 'loading' });
      try {
        const response = await apiClient.request({
          path: '/audit-log',
          query: {
            action: nextFilters.action || undefined,
            q: nextFilters.query || undefined,
          },
          schema: activityResponseSchema,
          signal,
        });
        if (!signal?.aborted) {
          setState({
            kind: 'ready',
            items: response.items,
            nextBeforeId: response.nextBeforeId,
            isLoadingMore: false,
          });
        }
      } catch (error) {
        if (signal?.aborted) return;
        if (error instanceof ApiError) {
          setState(
            error.status === 401 || error.status === 403
              ? { kind: 'forbidden' }
              : { kind: 'error' },
          );
          return;
        }
        throw error;
      }
    },
    [],
  );

  useEffect(() => {
    const controller = new AbortController();
    void loadFirstPage(EMPTY_FILTERS, controller.signal);
    return () => controller.abort();
  }, [loadFirstPage]);

  async function applyFilters(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    await loadFirstPage(filters);
  }

  async function resetFilters(): Promise<void> {
    setFilters(EMPTY_FILTERS);
    await loadFirstPage(EMPTY_FILTERS);
  }

  async function loadMore(): Promise<void> {
    if (state.kind !== 'ready' || state.nextBeforeId === null || state.isLoadingMore) return;

    const beforeId = state.nextBeforeId;
    setState({ ...state, isLoadingMore: true });
    try {
      const response = await apiClient.request({
        path: '/audit-log',
        query: {
          beforeId,
          action: filters.action || undefined,
          q: filters.query || undefined,
        },
        schema: activityResponseSchema,
      });
      setState(current =>
        current.kind === 'ready'
          ? {
              kind: 'ready',
              items: [...current.items, ...response.items],
              nextBeforeId: response.nextBeforeId,
              isLoadingMore: false,
            }
          : current,
      );
    } catch (error) {
      if (error instanceof ApiError) {
        setState({ kind: error.status === 401 || error.status === 403 ? 'forbidden' : 'error' });
        return;
      }
      throw error;
    }
  }

  if (state.kind === 'loading') {
    return <p className="text-sm text-[var(--color-muted-foreground)]">Loading activity…</p>;
  }
  if (state.kind === 'forbidden') {
    return (
      <section className="space-y-4">
        <h1 className="text-2xl font-semibold tracking-tight">Administrator access required</h1>
        <Link to="/" className="text-sm font-medium underline underline-offset-4">
          Return to dashboard
        </Link>
      </section>
    );
  }
  if (state.kind === 'error') {
    return (
      <section className="space-y-4">
        <h1 className="text-2xl font-semibold tracking-tight">Activity log unavailable</h1>
        <Link to="/" className="text-sm font-medium underline underline-offset-4">
          Return to dashboard
        </Link>
      </section>
    );
  }

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <Link to="/admin" className="text-sm font-medium underline underline-offset-4">
        ← Administration
      </Link>
      <div className="space-y-2">
        <p className="text-xs font-mono uppercase tracking-[0.18em] text-[var(--color-muted-foreground)]">
          Administration
        </p>
        <h1 className="text-2xl font-semibold tracking-tight">Activity log</h1>
      </div>
      <Card>
        <CardHeader>
          <CardTitle>Filter activity</CardTitle>
          <CardDescription>
            Apply filters to search recorded administrative activity.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form className="grid gap-4 sm:grid-cols-2" onSubmit={applyFilters}>
            <div className="space-y-2">
              <Label htmlFor="activity-action">Action</Label>
              <Input
                id="activity-action"
                value={filters.action}
                onChange={event => setFilters({ ...filters, action: event.target.value })}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="activity-search">Search activity</Label>
              <Input
                id="activity-search"
                value={filters.query}
                onChange={event => setFilters({ ...filters, query: event.target.value })}
              />
            </div>
            <div className="flex flex-wrap gap-3 sm:col-span-2">
              <Button type="submit">Apply filters</Button>
              <Button type="button" variant="outline" onClick={() => void resetFilters()}>
                Reset
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Recorded activity</CardTitle>
          <CardDescription>{state.items.length} entries loaded.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {state.items.length === 0 ? (
            <p className="text-sm text-[var(--color-muted-foreground)]">
              No activity matches your filters.
            </p>
          ) : (
            <ul className="divide-y rounded-md border">
              {state.items.map(item => (
                <li key={item.id} className="space-y-1 px-3 py-3 text-sm">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="font-medium">{item.action}</span>
                    <time
                      className="text-xs text-[var(--color-muted-foreground)]"
                      dateTime={item.timestamp}
                    >
                      {formatActivityTime(item.timestamp)}
                    </time>
                  </div>
                  <p className="text-[var(--color-muted-foreground)]">{actorLabel(item)}</p>
                  <p className="break-all text-[var(--color-muted-foreground)]">
                    {item.target ?? 'No target'}
                  </p>
                </li>
              ))}
            </ul>
          )}
          {state.nextBeforeId !== null ? (
            <Button
              type="button"
              variant="outline"
              disabled={state.isLoadingMore}
              onClick={() => void loadMore()}
            >
              {state.isLoadingMore ? 'Loading more…' : 'Load more'}
            </Button>
          ) : null}
        </CardContent>
      </Card>
    </div>
  );
}
