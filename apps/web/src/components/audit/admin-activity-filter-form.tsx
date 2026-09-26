import type { FormEvent } from 'react';
import { AuditFilterFields } from '@/components/audit/audit-filter-fields';
import { ListSearchInput } from '@/components/list/list-search-input';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import type { AuditFilterValues } from '@/lib/audit-contract';

export type AdminActivityFilters = AuditFilterValues & {
  readonly query: string;
};

type AdminActivityFilterFormProps = {
  readonly filters: AdminActivityFilters;
  readonly onChange: (filters: AdminActivityFilters) => void;
  readonly onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  readonly onReset: () => void;
};

export function AdminActivityFilterForm({
  filters,
  onChange,
  onSubmit,
  onReset,
}: AdminActivityFilterFormProps) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Filter activity</CardTitle>
        <CardDescription>Apply filters to search recorded administrative activity.</CardDescription>
      </CardHeader>
      <CardContent>
        <form className="space-y-4" onSubmit={onSubmit}>
          <ListSearchInput
            id="activity-search"
            label="Search activity"
            value={filters.query}
            onChange={value => onChange({ ...filters, query: value })}
            placeholder="Target or actor email"
          />
          <AuditFilterFields
            idPrefix="activity"
            filters={filters}
            onChange={nextFilters => onChange({ ...filters, ...nextFilters })}
          />
          <div className="flex flex-wrap gap-3 sm:col-span-2">
            <Button type="submit">Apply filters</Button>
            <Button type="button" variant="outline" onClick={onReset}>
              Reset
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
