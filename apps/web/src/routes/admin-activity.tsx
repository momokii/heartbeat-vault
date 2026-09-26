import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { AuditDetails } from '@/components/audit/audit-details';
import {
  AdminActivityFilterForm,
  type AdminActivityFilters,
} from '@/components/audit/admin-activity-filter-form';
import { ExportDialog } from '@/components/reports/export-dialog';
import { ListPagination } from '@/components/list/list-pagination';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  EMPTY_AUDIT_FILTERS,
  auditPageSchema,
  buildAuditQuery,
  getAuditActionLabel,
  getAuditCategoryLabel,
  type AuditItem,
} from '@/lib/audit-contract';
import { ApiError, apiClient } from '@/lib/api-client';

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

const EMPTY_FILTERS: AdminActivityFilters = { ...EMPTY_AUDIT_FILTERS, query: '' };

function formatActivityTime(timestamp: string): string {
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(
    new Date(timestamp),
  );
}

function actorLabel(item: AuditItem): string {
  return item.actorEmail ?? item.actorId ?? 'System';
}

export function AdminActivityPage() {
  const [filters, setFilters] = useState<AdminActivityFilters>(EMPTY_FILTERS);
  const [appliedFilters, setAppliedFilters] = useState<AdminActivityFilters>(EMPTY_FILTERS);
  const [state, setState] = useState<ActivityState>({ kind: 'loading' });
  const [dialogOpen, setDialogOpen] = useState(false);
  const [pageSize, setPageSize] = useState(10);
  const [cursors, setCursors] = useState<(number | null)[]>([null]);
  const [page, setPage] = useState(0);

  const loadPage = useCallback(
    async (
      nextFilters: AdminActivityFilters,
      cursor: number | null,
      size: number,
      signal?: AbortSignal,
    ): Promise<void> => {
      setState({ kind: 'loading' });
      try {
        const response = await apiClient.request({
          path: '/audit-log',
          query: {
            q: nextFilters.query || undefined,
            ...buildAuditQuery(nextFilters),
            ...(cursor === null ? {} : { beforeId: cursor }),
            limit: size,
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
    void loadPage(EMPTY_FILTERS, null, 10, controller.signal);
    return () => controller.abort();
  }, [loadPage]);

  async function applyFilters(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setAppliedFilters(filters);
    setCursors([null]);
    setPage(0);
    await loadPage(filters, null, pageSize);
  }

  async function resetFilters(): Promise<void> {
    setFilters(EMPTY_FILTERS);
    setAppliedFilters(EMPTY_FILTERS);
    setCursors([null]);
    setPage(0);
    await loadPage(EMPTY_FILTERS, null, pageSize);
  }

  async function goToNext(): Promise<void> {
    if (state.kind !== 'ready' || state.nextBeforeId === null) return;
    const cursor = state.nextBeforeId;
    setCursors(current => [...current.slice(0, page + 1), cursor]);
    setPage(page + 1);
    await loadPage(appliedFilters, cursor, pageSize);
  }

  async function goToPrev(): Promise<void> {
    if (page === 0) return;
    const cursor = cursors[page - 1] ?? null;
    setPage(page - 1);
    await loadPage(appliedFilters, cursor, pageSize);
  }

  async function changePageSize(size: number): Promise<void> {
    setPageSize(size);
    setCursors([null]);
    setPage(0);
    await loadPage(appliedFilters, null, size);
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
            <Button type="button" onClick={() => setDialogOpen(true)}>
              Export…
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
                    <span className="flex flex-wrap items-center gap-2">
                      <span className="font-medium">{getAuditActionLabel(item.action)}</span>
                      <span className="rounded bg-[var(--color-muted)] px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-[var(--color-muted-foreground)]">
                        {getAuditCategoryLabel(item.category)}
                      </span>
                    </span>
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
          <ListPagination
            idPrefix="activity"
            pageSize={pageSize}
            onPageSizeChange={size => void changePageSize(size)}
            canPrev={page > 0}
            onPrev={() => void goToPrev()}
            canNext={state.nextBeforeId !== null}
            onNext={() => void goToNext()}
            shownFrom={page * pageSize + 1}
            shownTo={page * pageSize + state.items.length}
          />
        </CardContent>
      </Card>
      {dialogOpen ? <ExportDialog onClose={() => setDialogOpen(false)} /> : null}
    </div>
  );
}
