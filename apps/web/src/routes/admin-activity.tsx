import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { AuditDetails } from '@/components/audit/audit-details';
import {
  AdminActivityFilterForm,
  type AdminActivityFilters,
} from '@/components/audit/admin-activity-filter-form';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  EMPTY_AUDIT_FILTERS,
  auditPageSchema,
  buildAuditQuery,
  type AuditItem,
} from '@/lib/audit-contract';
import { ApiError, apiClient } from '@/lib/api-client';

type ExportFormat = 'csv' | 'json';
type ActivityState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'forbidden' }
  | { readonly kind: 'error' }
  | {
      readonly kind: 'ready';
      readonly items: readonly AuditItem[];
      readonly nextBeforeId: number | null;
      readonly isLoadingMore: boolean;
    };

const EMPTY_FILTERS: AdminActivityFilters = { ...EMPTY_AUDIT_FILTERS, action: '', query: '' };
const IDLE_EXPORTS: Readonly<Record<ExportFormat, boolean>> = { csv: false, json: false };

function formatActivityTime(timestamp: string): string {
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(
    new Date(timestamp),
  );
}

function actorLabel(item: AuditItem): string {
  return item.actorEmail ?? item.actorId ?? 'System';
}

function downloadBlob(blob: Blob, format: ExportFormat): void {
  const objectUrl = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = objectUrl;
  link.download = `audit-log.${format}`;
  link.click();
  URL.revokeObjectURL(objectUrl);
}

export function AdminActivityPage() {
  const [filters, setFilters] = useState<AdminActivityFilters>(EMPTY_FILTERS);
  const [appliedFilters, setAppliedFilters] = useState<AdminActivityFilters>(EMPTY_FILTERS);
  const [state, setState] = useState<ActivityState>({ kind: 'loading' });
  const [exportsInFlight, setExportsInFlight] = useState(IDLE_EXPORTS);

  const loadFirstPage = useCallback(
    async (nextFilters: AdminActivityFilters, signal?: AbortSignal): Promise<void> => {
      setState({ kind: 'loading' });
      try {
        const response = await apiClient.request({
          path: '/audit-log',
          query: {
            action: nextFilters.action || undefined,
            q: nextFilters.query || undefined,
            ...buildAuditQuery(nextFilters),
          },
          schema: auditPageSchema,
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
    setAppliedFilters(filters);
    await loadFirstPage(filters);
  }

  async function resetFilters(): Promise<void> {
    setFilters(EMPTY_FILTERS);
    setAppliedFilters(EMPTY_FILTERS);
    await loadFirstPage(EMPTY_FILTERS);
  }

  async function loadMore(): Promise<void> {
    if (state.kind !== 'ready' || state.nextBeforeId === null || state.isLoadingMore) return;

    setState({ ...state, isLoadingMore: true });
    try {
      const response = await apiClient.request({
        path: '/audit-log',
        query: {
          ...buildAuditQuery(appliedFilters, state.nextBeforeId),
          action: appliedFilters.action || undefined,
          q: appliedFilters.query || undefined,
        },
        schema: auditPageSchema,
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

  async function exportActivity(format: ExportFormat): Promise<void> {
    setExportsInFlight(current => ({ ...current, [format]: true }));
    try {
      const blob = await apiClient.download({
        path: '/audit-log/export',
        query: { ...buildAuditQuery(appliedFilters), format },
      });
      downloadBlob(blob, format);
    } finally {
      setExportsInFlight(current => ({ ...current, [format]: false }));
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
      <AdminActivityFilterForm
        filters={filters}
        onChange={setFilters}
        onSubmit={event => void applyFilters(event)}
        onReset={() => void resetFilters()}
      />
      <Card>
        <CardHeader>
          <CardTitle>Recorded activity</CardTitle>
          <CardDescription>{state.items.length} entries loaded.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap gap-3">
            <Button
              type="button"
              variant="outline"
              disabled={exportsInFlight.csv}
              onClick={() => void exportActivity('csv')}
            >
              {exportsInFlight.csv ? 'Exporting CSV…' : 'Export CSV'}
            </Button>
            <Button
              type="button"
              variant="outline"
              disabled={exportsInFlight.json}
              onClick={() => void exportActivity('json')}
            >
              {exportsInFlight.json ? 'Exporting JSON…' : 'Export JSON'}
            </Button>
          </div>
          {state.items.length === 0 ? (
            <p className="text-sm text-[var(--color-muted-foreground)]">
              No activity matches your filters.
            </p>
          ) : (
            <ul className="divide-y rounded-md border">
              {state.items.map(item => (
                <li key={item.id} className="space-y-2 px-3 py-3 text-sm">
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
                  <AuditDetails details={item.details} />
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
