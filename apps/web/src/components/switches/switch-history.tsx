import { AuditDetails } from '@/components/audit/audit-details';
import { AuditFilterFields } from '@/components/audit/audit-filter-fields';
import { ListPagination } from '@/components/list/list-pagination';
import { ListSearchInput } from '@/components/list/list-search-input';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { getAuditActionLabel, getAuditCategoryLabel, type AuditItem } from '@/lib/audit-contract';
import type { AuditHistoryFilters, SwitchHistoryPagination } from './use-switch-history';

export type AuditHistoryState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'unavailable' }
  | {
      readonly kind: 'ready';
      readonly items: readonly AuditItem[];
      readonly nextBeforeId: number | null;
      readonly loadingMore: boolean;
      readonly message: string | null;
    };

type SwitchHistoryProps = {
  readonly state: AuditHistoryState;
  readonly filters: AuditHistoryFilters;
  readonly onFiltersChange: (filters: AuditHistoryFilters) => void;
  readonly onApplyFilters: () => Promise<void>;
  readonly onResetFilters: () => Promise<void>;
  readonly pagination: SwitchHistoryPagination;
};

const timestampFormatter = new Intl.DateTimeFormat(undefined, {
  dateStyle: 'medium',
  timeStyle: 'short',
});

export function SwitchHistory({
  state,
  filters,
  onFiltersChange,
  onApplyFilters,
  onResetFilters,
  pagination,
}: SwitchHistoryProps) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>History</CardTitle>
        <CardDescription>Recorded activity for this switch.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <form
          className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4"
          onSubmit={event => {
            event.preventDefault();
            void onApplyFilters();
          }}
        >
          <ListSearchInput
            id="history-search"
            value={filters.query}
            onChange={value => onFiltersChange({ ...filters, query: value })}
            placeholder="Search by actor email"
          />
          <AuditFilterFields
            idPrefix="history"
            filters={filters}
            onChange={next => onFiltersChange({ ...filters, ...next })}
          />
          <div className="flex flex-wrap gap-3 sm:col-span-2 lg:col-span-4">
            <Button type="submit">Apply filters</Button>
            <Button type="button" variant="outline" onClick={() => void onResetFilters()}>
              Reset
            </Button>
          </div>
        </form>
        {state.kind === 'loading' ? (
          <p className="text-sm text-[var(--color-muted-foreground)]">Loading history…</p>
        ) : state.kind === 'unavailable' ? (
          <p role="status" className="text-sm text-[var(--color-muted-foreground)]">
            History is temporarily unavailable.
          </p>
        ) : state.items.length === 0 ? (
          <p className="text-sm text-[var(--color-muted-foreground)]">
            No recorded activity for this switch.
          </p>
        ) : (
          <ul className="divide-y rounded-md border">
            {state.items.map(item => (
              <li key={item.id} className="space-y-2 px-3 py-3 text-sm">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="min-w-0">
                    <p className="flex flex-wrap items-center gap-2 font-medium">
                      <span>{getAuditActionLabel(item.action)}</span>
                      <span className="rounded bg-[var(--color-muted)] px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-[var(--color-muted-foreground)]">
                        {getAuditCategoryLabel(item.category)}
                      </span>
                    </p>
                    {item.target !== null ? (
                      <p className="truncate font-mono text-xs text-[var(--color-muted-foreground)]">
                        {item.target}
                      </p>
                    ) : null}
                  </div>
                  <div className="text-right text-xs text-[var(--color-muted-foreground)]">
                    <p>{item.actorEmail ?? 'Unknown actor'}</p>
                    <p>{timestampFormatter.format(new Date(item.timestamp))}</p>
                  </div>
                </div>
                <AuditDetails details={item.details} />
              </li>
            ))}
          </ul>
        )}
        {state.kind === 'ready' && state.message !== null ? (
          <p role="status" className="text-sm text-[var(--color-muted-foreground)]">
            {state.message}
          </p>
        ) : null}
        <ListPagination idPrefix="history" {...pagination} />
      </CardContent>
    </Card>
  );
}
