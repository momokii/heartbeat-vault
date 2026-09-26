import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ExportDialog } from '@/components/reports/export-dialog';
import { ListPagination } from '@/components/list/list-pagination';
import { ListSearchInput } from '@/components/list/list-search-input';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { ApiError, apiClient } from '@/lib/api-client';
import {
  describeExportFilters,
  exportJobPageSchema,
  formatReportDate,
  switchOptionSchema,
  type ExportJob,
  type ReportFormat,
  type ReportScope,
  type SwitchOption,
} from '@/lib/reports-contract';

type ReportStatusFilter = '' | 'success' | 'failed';
type ReportScopeFilter = '' | ReportScope;
type ReportFormatFilter = '' | ReportFormat;

type ReportsState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'forbidden' }
  | { readonly kind: 'error' }
  | {
      readonly kind: 'ready';
      readonly items: readonly ExportJob[];
      readonly nextBeforeId: number | null;
      readonly isLoadingMore: boolean;
    };

const EMPTY_FILTERS = {
  scope: '' as ReportScopeFilter,
  switchId: '',
  status: '' as ReportStatusFilter,
  format: '' as ReportFormatFilter,
  query: '',
};

function statusLabel(job: ExportJob): string {
  return job.status === 'success' ? 'Success' : `Failed (${job.errorCode ?? 'unknown'})`;
}

function reportLabel(job: ExportJob): string {
  return job.scopeType === 'global'
    ? 'Audit log'
    : `Switch — ${job.switchTitle ?? 'deleted switch'}`;
}

export function AdminReportsPage() {
  const [filters, setFilters] = useState(EMPTY_FILTERS);
  const [appliedFilters, setAppliedFilters] = useState(EMPTY_FILTERS);
  const [state, setState] = useState<ReportsState>({ kind: 'loading' });
  const [dialogOpen, setDialogOpen] = useState(false);
  const [switchOptions, setSwitchOptions] = useState<readonly SwitchOption[]>([]);
  const [pageSize, setPageSize] = useState(10);
  const [cursors, setCursors] = useState<(number | null)[]>([null]);
  const [page, setPage] = useState(0);

  const loadPage = useCallback(
    async (
      nextFilters: typeof EMPTY_FILTERS,
      cursor: number | null,
      size: number,
      signal?: AbortSignal,
    ): Promise<void> => {
      setState({ kind: 'loading' });
      try {
        const response = await apiClient.request({
          path: '/reports/exports',
          query: {
            scope: nextFilters.scope || undefined,
            switchId: nextFilters.switchId || undefined,
            status: nextFilters.status || undefined,
            format: nextFilters.format || undefined,
            q: nextFilters.query || undefined,
            ...(cursor === null ? {} : { beforeId: cursor }),
            limit: size,
          },
          schema: exportJobPageSchema,
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
    void loadPage(EMPTY_FILTERS, null, 10);
  }, [loadPage]);

  useEffect(() => {
    const controller = new AbortController();
    apiClient
      .request({
        path: '/switches',
        query: { all: 1 },
        schema: switchOptionSchema.array(),
        signal: controller.signal,
      })
      .then(rows => setSwitchOptions([...rows].sort((a, b) => a.title.localeCompare(b.title))))
      .catch(() => setSwitchOptions([]));
    return () => controller.abort();
  }, []);

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

  function updateFilters(next: typeof EMPTY_FILTERS): void {
    setFilters(next);
    setAppliedFilters(next);
    setCursors([null]);
    setPage(0);
    void loadPage(next, null, pageSize);
  }

  if (state.kind === 'loading') {
    return <p className="text-sm text-[var(--color-muted-foreground)]">Loading reports…</p>;
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
        <h1 className="text-2xl font-semibold tracking-tight">Reports unavailable</h1>
        <Link to="/" className="text-sm font-medium underline underline-offset-4">
          Return to dashboard
        </Link>
      </section>
    );
  }

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <Link to="/admin" className="text-sm font-medium underline underline-offset-4">
        ← Administration
      </Link>
      <div className="space-y-2">
        <p className="text-xs font-mono uppercase tracking-[0.18em] text-[var(--color-muted-foreground)]">
          Administration
        </p>
        <h1 className="text-2xl font-semibold tracking-tight">Reports</h1>
        <p className="text-sm text-[var(--color-muted-foreground)]">
          Every audit export from this vault is recorded here — who exported it, what it covered,
          and whether it succeeded.
        </p>
      </div>
      <Card>
        <CardHeader className="flex flex-row items-start justify-between space-y-0">
          <div className="space-y-1.5">
            <CardTitle>Exported reports</CardTitle>
            <CardDescription>{state.items.length} exports loaded.</CardDescription>
          </div>
          <Button type="button" onClick={() => setDialogOpen(true)}>
            Export…
          </Button>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <ListSearchInput
              id="reports-search"
              value={filters.query}
              onChange={value => updateFilters({ ...filters, query: value })}
              placeholder="Requester or switch title"
            />
            <div className="space-y-2">
              <Label htmlFor="reports-scope">Report type</Label>
              <Select
                id="reports-scope"
                value={filters.scope}
                onChange={event => {
                  const value = event.currentTarget.value as ReportScopeFilter;
                  updateFilters({
                    ...filters,
                    scope: value,
                    switchId: value === 'switch' ? filters.switchId : '',
                  });
                }}
              >
                <option value="">All types</option>
                <option value="global">Audit log</option>
                <option value="switch">Switch reports</option>
              </Select>
            </div>
            {filters.scope === 'switch' ? (
              <div className="space-y-2">
                <Label htmlFor="reports-switch">Switch</Label>
                <Select
                  id="reports-switch"
                  value={filters.switchId}
                  onChange={event => {
                    updateFilters({ ...filters, switchId: event.currentTarget.value });
                  }}
                >
                  <option value="">All switches</option>
                  {switchOptions.map(option => (
                    <option key={option.id} value={option.id}>
                      {option.title}
                      {option.ownerEmail ? ` — ${option.ownerEmail}` : ''}
                    </option>
                  ))}
                </Select>
              </div>
            ) : null}
            <div className="space-y-2">
              <Label htmlFor="reports-status">Status</Label>
              <Select
                id="reports-status"
                value={filters.status}
                onChange={event => {
                  updateFilters({
                    ...filters,
                    status: event.currentTarget.value as ReportStatusFilter,
                  });
                }}
              >
                <option value="">All statuses</option>
                <option value="success">Success</option>
                <option value="failed">Failed</option>
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="reports-format">Format</Label>
              <Select
                id="reports-format"
                value={filters.format}
                onChange={event => {
                  updateFilters({
                    ...filters,
                    format: event.currentTarget.value as ReportFormatFilter,
                  });
                }}
              >
                <option value="">All formats</option>
                <option value="csv">CSV</option>
                <option value="json">JSON</option>
              </Select>
            </div>
          </div>
          {state.items.length === 0 ? (
            <p className="text-sm text-[var(--color-muted-foreground)]">
              No exports recorded yet. Use Export… to create the first one.
            </p>
          ) : (
            <div className="overflow-x-auto rounded-md border">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b bg-[var(--color-muted)] text-left">
                    <th className="px-3 py-2 font-medium">When</th>
                    <th className="px-3 py-2 font-medium">Report</th>
                    <th className="px-3 py-2 font-medium">Format</th>
                    <th className="px-3 py-2 font-medium">Date range</th>
                    <th className="px-3 py-2 font-medium">Requested by</th>
                    <th className="px-3 py-2 font-medium">Rows</th>
                    <th className="px-3 py-2 font-medium">Status</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {state.items.map(job => (
                    <tr key={job.id}>
                      <td className="px-3 py-2 whitespace-nowrap">
                        {formatReportDate(job.createdAt)}
                      </td>
                      <td className="px-3 py-2">{reportLabel(job)}</td>
                      <td className="px-3 py-2 uppercase">{job.format}</td>
                      <td className="px-3 py-2">{describeExportFilters(job.filters)}</td>
                      <td className="px-3 py-2">{job.requestedByEmail ?? 'Unknown'}</td>
                      <td className="px-3 py-2">{job.rowCount ?? '—'}</td>
                      <td className="px-3 py-2">{statusLabel(job)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <ListPagination
            idPrefix="reports"
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
      {dialogOpen ? (
        <ExportDialog
          onClose={() => setDialogOpen(false)}
          onExported={() => void loadPage(filters, null, pageSize)}
        />
      ) : null}
    </div>
  );
}
