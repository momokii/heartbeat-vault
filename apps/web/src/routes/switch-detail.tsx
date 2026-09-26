import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { z } from 'zod';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { FieldGuidance } from '@/components/ui/field-guidance';
import { SwitchSetup } from '@/components/switches/switch-setup';
import { HeartbeatCheckin } from '@/components/switches/heartbeat-checkin';
import { TriggerConfiguration } from '@/components/switches/trigger-configuration';
import { SwitchSettings } from '@/components/switches/switch-settings';
import { SwitchHistory } from '@/components/switches/switch-history';
import { useSwitchHistory } from '@/components/switches/use-switch-history';
import { apiClient, ApiError } from '@/lib/api-client';

const switchSchema = z.object({
  id: z.string().uuid(),
  title: z.string(),
  mode: z.string(),
  status: z.string(),
  heartbeatIntervalHours: z.number().int(),
  graceWindowHours: z.number().int(),
  dryRun: z.boolean(),
  releasePolicy: z.string(),
  heartbeatStartedAt: z.string().datetime().nullable(),
  nextDeadline: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
const operationSchema = z.object({ ok: z.literal(true), status: z.enum(['active', 'paused']) });
type Switch = z.infer<typeof switchSchema>;
type State =
  | { readonly kind: 'loading' }
  | { readonly kind: 'missing' }
  | { readonly kind: 'error'; readonly message: string }
  | {
      readonly kind: 'ready';
      readonly item: Switch;
      readonly busy: boolean;
      readonly message: string | null;
    };

function armError(error: unknown): string {
  if (!(error instanceof ApiError) || error.status !== 409)
    return 'The switch could not be updated. Try again.';
  return 'This switch cannot be armed yet. Add a sealed payload and an accepted recipient first.';
}

export function SwitchDetailPage() {
  const { id } = useParams();
  const [state, setState] = useState<State>({ kind: 'loading' });
  useEffect(() => {
    const controller = new AbortController();
    async function loadSwitch(): Promise<void> {
      if (!id || !z.string().uuid().safeParse(id).success) {
        setState({ kind: 'missing' });
        return;
      }
      try {
        const item = await apiClient.request({
          path: `/switches/${id}`,
          schema: switchSchema,
          signal: controller.signal,
        });
        setState({ kind: 'ready', item, busy: false, message: null });
      } catch (error) {
        if (!controller.signal.aborted)
          setState(
            error instanceof ApiError && error.status === 404
              ? { kind: 'missing' }
              : { kind: 'error', message: 'The switch could not be loaded.' },
          );
      }
    }
    void loadSwitch();
    return () => controller.abort();
  }, [id]);
  const {
    historyState,
    historyFilters,
    setHistoryFilters,
    applyHistoryFilters,
    resetHistoryFilters,
    loadMoreHistory,
  } = useSwitchHistory(id);
  async function update(active: boolean): Promise<void> {
    if (state.kind !== 'ready' || !id) return;
    setState({ ...state, busy: true, message: null });
    try {
      const result = await apiClient.request({
        method: 'POST',
        path: `/switches/${id}/${active ? 'arm' : 'disarm'}`,
        body: active
          ? {
              confirm: true,
              ...(state.item.releasePolicy === 'fail_deadly'
                ? { failDeadlyConfirmation: state.item.id }
                : {}),
            }
          : undefined,
        schema: operationSchema,
      });
      setState({
        kind: 'ready',
        item: { ...state.item, status: result.status },
        busy: false,
        message: active
          ? 'Switch armed. Its heartbeat deadline is now active.'
          : 'Switch paused. No heartbeat deadline is running.',
      });
    } catch (error) {
      setState({
        ...state,
        busy: false,
        message: active ? armError(error) : 'The switch could not be paused. Try again.',
      });
    }
  }
  if (state.kind === 'loading')
    return <p className="text-sm text-[var(--color-muted-foreground)]">Loading switch…</p>;
  if (state.kind === 'missing')
    return (
      <section className="space-y-4">
        <h1 className="text-2xl font-semibold">Switch not found</h1>
        <Link to="/" className="text-sm font-medium underline underline-offset-4">
          Return to dashboard
        </Link>
      </section>
    );
  if (state.kind === 'error')
    return (
      <section className="space-y-4">
        <h1 className="text-2xl font-semibold">Unable to load switch</h1>
        <p className="text-sm text-[var(--color-muted-foreground)]">{state.message}</p>
        <Link to="/" className="text-sm font-medium underline underline-offset-4">
          Return to dashboard
        </Link>
      </section>
    );
  const active = state.item.status === 'active';
  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <Link to="/" className="text-sm font-medium underline underline-offset-4">
        ← Dashboard
      </Link>
      <div className="space-y-2">
        <p className="text-xs font-mono uppercase tracking-[0.18em] text-[var(--color-muted-foreground)]">
          Switch details
        </p>
        <h1 className="text-2xl font-semibold tracking-tight">{state.item.title}</h1>
        <p className="text-sm text-[var(--color-muted-foreground)]">
          {state.item.mode === 'asymmetric_key' ? 'Key release' : 'Direct delivery'} ·{' '}
          {state.item.status}
        </p>
      </div>
      <Card>
        <CardHeader>
          <CardTitle>Heartbeat settings</CardTitle>
          <CardDescription>
            Check in every {state.item.heartbeatIntervalHours} hours. Grace period:{' '}
            {state.item.graceWindowHours} hours.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm text-[var(--color-muted-foreground)]">
            Release policy:{' '}
            {state.item.releasePolicy === 'fail_deadly' ? 'Fail deadly' : 'Fail safe'}
            {state.item.dryRun ? ' · Dry run enabled' : ''}.
          </p>
          {state.message ? (
            <p role="status" className="text-sm text-[var(--color-muted-foreground)]">
              {state.message}
            </p>
          ) : null}
          <Button
            type="button"
            variant={active ? 'outline' : 'default'}
            disabled={state.busy || state.item.status === 'released'}
            onClick={() => void update(!active)}
          >
            {state.busy ? 'Updating…' : active ? 'Pause switch' : 'Arm switch'}
          </Button>
          <FieldGuidance
            field={active ? 'pausing this switch' : 'arming this switch'}
            description={
              active
                ? 'Pausing stops the heartbeat deadline until the switch is armed again.'
                : 'Arming requires an accepted recipient and a sealed payload. A fail_deadly switch also sends its required typed confirmation at arm time.'
            }
            example={
              active
                ? 'Pause a switch while you are changing its recipients.'
                : 'Arm after recipient@example.com accepts the invitation and a payload is sealed.'
            }
          />
          {!active && state.item.status !== 'released' ? (
            <p className="text-xs text-[var(--color-muted-foreground)]">
              Arming requires at least one accepted recipient and a sealed payload.
            </p>
          ) : null}
        </CardContent>
      </Card>
      <SwitchHistory
        state={historyState}
        filters={historyFilters}
        onFiltersChange={setHistoryFilters}
        onApplyFilters={applyHistoryFilters}
        onResetFilters={resetHistoryFilters}
        onLoadMore={() => void loadMoreHistory()}
      />
      <SwitchSetup switchId={state.item.id} disabled={state.item.status === 'released'} />
      <HeartbeatCheckin switchId={state.item.id} active={active} />
      <TriggerConfiguration switchId={state.item.id} disabled={state.item.status === 'released'} />
      <SwitchSettings
        item={state.item}
        onUpdated={item =>
          setState({
            kind: 'ready',
            item: { ...state.item, ...item },
            busy: false,
            message: 'Settings saved.',
          })
        }
      />
    </div>
  );
}
