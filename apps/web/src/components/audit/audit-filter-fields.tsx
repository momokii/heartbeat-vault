import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import {
  AUDIT_CATEGORIES,
  type AuditCategory,
  type AuditFilterValues,
  parseAuditCategory,
} from '@/lib/audit-contract';

const CATEGORY_LABELS: Record<AuditCategory, string> = {
  auth: 'Authentication',
  switch: 'Switch',
  account: 'Account',
  admin: 'Administration',
  invite: 'Invitation',
  '2fa': 'Two-factor authentication',
  trigger: 'Trigger',
  heartbeat: 'Heartbeat',
  delivery: 'Delivery',
  system: 'System',
};

type AuditFilterFieldsProps = {
  readonly idPrefix: string;
  readonly filters: AuditFilterValues;
  readonly onChange: (filters: AuditFilterValues) => void;
};

export function AuditFilterFields({ idPrefix, filters, onChange }: AuditFilterFieldsProps) {
  return (
    <div className="grid gap-4 sm:col-span-full sm:grid-cols-3">
      <div className="space-y-2">
        <Label htmlFor={`${idPrefix}-category`}>Category</Label>
        <Select
          id={`${idPrefix}-category`}
          value={filters.category}
          onChange={event =>
            onChange({ ...filters, category: parseAuditCategory(event.currentTarget.value) })
          }
        >
          <option value="">All categories</option>
          {AUDIT_CATEGORIES.map(category => (
            <option key={category} value={category}>
              {CATEGORY_LABELS[category]}
            </option>
          ))}
        </Select>
      </div>
      <div className="space-y-2">
        <Label htmlFor={`${idPrefix}-from`}>From</Label>
        <Input
          id={`${idPrefix}-from`}
          type="datetime-local"
          value={filters.from}
          onChange={event => onChange({ ...filters, from: event.currentTarget.value })}
        />
      </div>
      <div className="space-y-2">
        <Label htmlFor={`${idPrefix}-to`}>To</Label>
        <Input
          id={`${idPrefix}-to`}
          type="datetime-local"
          value={filters.to}
          onChange={event => onChange({ ...filters, to: event.currentTarget.value })}
        />
      </div>
    </div>
  );
}
