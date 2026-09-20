import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { z } from 'zod';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { apiClient } from '@/lib/api-client';

const formSchema = z.object({
  title: z.string().trim().min(1, 'Give this switch a name.').max(200),
  mode: z.enum(['asymmetric_key', 'direct_delivery']),
  heartbeatIntervalHours: z.coerce
    .number()
    .int()
    .min(24, 'Use at least a 24-hour interval.')
    .max(2160),
  graceWindowHours: z.coerce.number().int().min(2, 'Use at least a 2-hour grace window.'),
  releasePolicy: z.enum(['fail_safe', 'fail_deadly']),
  dryRun: z.boolean(),
});
const responseSchema = z.object({
  id: z.string().uuid(),
  status: z.literal('paused'),
  dryRun: z.boolean(),
});
type State =
  | { readonly kind: 'idle' }
  | { readonly kind: 'submitting' }
  | { readonly kind: 'error'; readonly message: string };

export function NewSwitchPage() {
  const [state, setState] = useState<State>({ kind: 'idle' });
  const navigate = useNavigate();
  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const values = new FormData(event.currentTarget);
    const parsed = formSchema.safeParse({
      title: values.get('title'),
      mode: values.get('mode'),
      heartbeatIntervalHours: values.get('heartbeatIntervalHours'),
      graceWindowHours: values.get('graceWindowHours'),
      releasePolicy: values.get('releasePolicy'),
      dryRun: values.get('dryRun') === 'on',
    });
    if (!parsed.success) {
      setState({
        kind: 'error',
        message: parsed.error.issues[0]?.message ?? 'Check the form and try again.',
      });
      return;
    }
    setState({ kind: 'submitting' });
    try {
      await apiClient.request({
        method: 'POST',
        path: '/switches',
        body: parsed.data,
        schema: responseSchema,
      });
      navigate('/');
    } catch {
      setState({
        kind: 'error',
        message: 'The switch could not be created. Check your session and try again.',
      });
    }
  }
  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <div className="space-y-2">
        <p className="text-xs font-mono uppercase tracking-[0.18em] text-[var(--color-muted-foreground)]">
          New switch
        </p>
        <h1 className="text-2xl font-semibold tracking-tight">Create a dead man&apos;s switch</h1>
        <p className="text-sm text-[var(--color-muted-foreground)]">
          Creation starts paused. Add a recipient and sealed payload before arming it.
        </p>
      </div>
      <Card>
        <CardHeader>
          <CardTitle>Switch settings</CardTitle>
          <CardDescription>
            Choose how this switch releases and how often it needs a heartbeat.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form className="space-y-5" onSubmit={submit} noValidate>
            <div className="space-y-2">
              <Label htmlFor="switch-title">Name</Label>
              <Input id="switch-title" name="title" required maxLength={200} />
            </div>
            <fieldset className="space-y-2">
              <legend className="text-sm font-medium">Release mode</legend>
              <label className="flex gap-2 text-sm">
                <input type="radio" name="mode" value="asymmetric_key" defaultChecked /> Release an
                encryption key
              </label>
              <label className="flex gap-2 text-sm">
                <input type="radio" name="mode" value="direct_delivery" /> Deliver the sealed
                message directly
              </label>
            </fieldset>
            <div className="grid gap-5 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="heartbeat-interval">Heartbeat interval (hours)</Label>
                <Input
                  id="heartbeat-interval"
                  name="heartbeatIntervalHours"
                  type="number"
                  min="24"
                  max="2160"
                  defaultValue="168"
                  required
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="grace-window">Grace window (hours)</Label>
                <Input
                  id="grace-window"
                  name="graceWindowHours"
                  type="number"
                  min="2"
                  defaultValue="24"
                  required
                />
              </div>
            </div>
            <fieldset className="space-y-2">
              <legend className="text-sm font-medium">Release policy</legend>
              <label className="flex gap-2 text-sm">
                <input type="radio" name="releasePolicy" value="fail_safe" defaultChecked /> Fail
                safe — do not release when the service is uncertain
              </label>
              <label className="flex gap-2 text-sm">
                <input type="radio" name="releasePolicy" value="fail_deadly" /> Fail deadly —
                release if the service cannot continue
              </label>
            </fieldset>
            <label className="flex gap-2 text-sm">
              <input name="dryRun" type="checkbox" /> Test deliveries without releasing a payload
            </label>
            {state.kind === 'error' ? (
              <p role="alert" className="text-sm text-[var(--color-destructive)]">
                {state.message}
              </p>
            ) : null}
            <Button type="submit" disabled={state.kind === 'submitting'}>
              {state.kind === 'submitting' ? 'Creating switch…' : 'Create paused switch'}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
