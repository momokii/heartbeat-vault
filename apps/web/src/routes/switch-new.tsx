import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { z } from 'zod';
import { ApiError, apiClient } from '@/lib/api-client';
import { releaseModes, releasePolicies } from './switch-new-guidance';
import {
  defaultSwitchFormValues,
  NewSwitchForm,
  type SwitchFormState,
  type SwitchFormValues,
} from './switch-new-form';

const formSchema = z.object({
  title: z.string().trim().min(1, 'Give this switch a name.').max(200),
  mode: z.enum(releaseModes),
  heartbeatIntervalHours: z.coerce
    .number()
    .int()
    .min(24, 'Use at least a 24-hour interval.')
    .max(2160),
  graceWindowHours: z.coerce.number().int().min(2, 'Use at least a 2-hour grace window.'),
  releasePolicy: z.enum(releasePolicies),
  dryRun: z.boolean(),
});
const responseSchema = z.object({
  id: z.string().uuid(),
  status: z.literal('paused'),
  dryRun: z.boolean(),
});
export function NewSwitchPage() {
  const [state, setState] = useState<SwitchFormState>({ kind: 'idle' });
  const [values, setValues] = useState<SwitchFormValues>(defaultSwitchFormValues);
  const navigate = useNavigate();
  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const parsed = formSchema.safeParse(values);
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
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) {
        setState({ kind: 'error', message: 'You already have a switch with this title.' });
        return;
      }
      if (error instanceof Error) {
        setState({
          kind: 'error',
          message: 'The switch could not be created. Check your session and try again.',
        });
        return;
      }
      throw error;
    }
  }
  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <div className="space-y-2">
        <p className="text-xs font-mono uppercase tracking-[0.18em] text-[var(--color-muted-foreground)]">
          New switch
        </p>
        <h1 className="text-2xl font-semibold tracking-tight">Create a dead man&apos;s switch</h1>
        <p className="text-sm text-[var(--color-muted-foreground)]">
          Creation starts paused. Add a recipient and sealed payload before arming it.
        </p>
      </div>
      <NewSwitchForm values={values} state={state} onValuesChange={setValues} onSubmit={submit} />
    </div>
  );
}
