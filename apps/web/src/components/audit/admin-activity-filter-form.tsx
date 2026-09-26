import type { FormEvent } from 'react';
import { AuditFilterFields } from '@/components/audit/audit-filter-fields';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
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
          <div className="space-y-2">
            <Label htmlFor="activity-search">Search activity</Label>
            <Input
              id="activity-search"
              value={filters.query}
              onChange={event => onChange({ ...filters, query: event.currentTarget.value })}
              placeholder="Target or actor email"
            />
          </div>
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
