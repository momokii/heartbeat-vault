import type { AuditItem } from '@/lib/audit-contract';

type AuditDetailsProps = {
  readonly details: AuditItem['details'];
};

export function AuditDetails({ details }: AuditDetailsProps) {
  return (
    <details>
      <summary className="cursor-pointer text-xs font-medium text-[var(--color-muted-foreground)]">
        Details
      </summary>
      <pre className="mt-2 max-w-full overflow-x-auto rounded-md border bg-[var(--color-secondary)] p-3 font-mono text-xs leading-5 text-[var(--color-foreground)]">
        {JSON.stringify(details, null, 2)}
      </pre>
    </details>
  );
}
