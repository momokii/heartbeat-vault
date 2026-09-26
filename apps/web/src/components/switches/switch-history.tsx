import { z } from 'zod';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

const auditItemSchema = z.object({
  id: z.number().int(),
  timestamp: z.string().datetime(),
  actorId: z.string().nullable(),
  actorEmail: z.string().email().nullable(),
  action: z.string(),
  target: z.string().nullable(),
});

export const auditPageSchema = z.object({
  items: z.array(auditItemSchema),
  nextBeforeId: z.number().int().nullable(),
});

export type AuditHistoryState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'unavailable' }
  | {
      readonly kind: 'ready';
      readonly items: readonly z.infer<typeof auditItemSchema>[];
      readonly nextBeforeId: number | null;
      readonly loadingMore: boolean;
      readonly message: string | null;
    };

type SwitchHistoryProps = {
  readonly state: AuditHistoryState;
  readonly onLoadMore: () => void;
};

const timestampFormatter = new Intl.DateTimeFormat(undefined, {
  dateStyle: 'medium',
  timeStyle: 'short',
});

export function SwitchHistory({ state, onLoadMore }: SwitchHistoryProps) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>History</CardTitle>
        <CardDescription>Recorded activity for this switch.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
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
              <li
                key={item.id}
                className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-sm"
              >
                <div className="min-w-0">
                  <p className="font-medium">{item.action}</p>
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
              </li>
            ))}
          </ul>
        )}
        {state.kind === 'ready' && state.message !== null ? (
          <p role="status" className="text-sm text-[var(--color-muted-foreground)]">
            {state.message}
          </p>
        ) : null}
        {state.kind === 'ready' && state.nextBeforeId !== null ? (
          <Button type="button" variant="outline" disabled={state.loadingMore} onClick={onLoadMore}>
            {state.loadingMore ? 'Loading more…' : 'Load more'}
          </Button>
        ) : null}
      </CardContent>
    </Card>
  );
}
