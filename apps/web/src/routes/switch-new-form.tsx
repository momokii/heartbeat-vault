import type { FormEvent } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  FieldGuidance,
  SwitchOutcomePreview,
  type ReleaseMode,
  type ReleasePolicy,
} from './switch-new-guidance';

export type SwitchFormState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'submitting' }
  | { readonly kind: 'error'; readonly message: string };

export type SwitchFormValues = {
  readonly title: string;
  readonly mode: ReleaseMode;
  readonly heartbeatIntervalHours: string;
  readonly graceWindowHours: string;
  readonly releasePolicy: ReleasePolicy;
  readonly dryRun: boolean;
};

type NewSwitchFormProps = {
  readonly values: SwitchFormValues;
  readonly state: SwitchFormState;
  readonly onValuesChange: (values: SwitchFormValues) => void;
  readonly onSubmit: (event: FormEvent<HTMLFormElement>) => void;
};

const exampleValues: SwitchFormValues = {
  title: 'Family recovery plan',
  mode: 'direct_delivery',
  heartbeatIntervalHours: '168',
  graceWindowHours: '24',
  releasePolicy: 'fail_safe',
  dryRun: true,
};

export const defaultSwitchFormValues: SwitchFormValues = {
  title: '',
  mode: 'asymmetric_key',
  heartbeatIntervalHours: '168',
  graceWindowHours: '24',
  releasePolicy: 'fail_safe',
  dryRun: false,
};

export function NewSwitchForm({ values, state, onValuesChange, onSubmit }: NewSwitchFormProps) {
  return (
    <div className="grid gap-6 lg:grid-cols-3">
      <Card className="lg:col-span-2">
        <CardHeader>
          <CardTitle>Switch settings</CardTitle>
          <CardDescription>
            Choose how this switch releases and how often it needs a heartbeat.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form className="space-y-6" onSubmit={onSubmit} noValidate>
            <Button type="button" variant="secondary" onClick={() => onValuesChange(exampleValues)}>
              Fill with example values
            </Button>
            <div className="space-y-2">
              <Label htmlFor="switch-title">Name</Label>
              <Input
                id="switch-title"
                name="title"
                value={values.title}
                onChange={event => onValuesChange({ ...values, title: event.target.value })}
                required
                maxLength={200}
              />
              <FieldGuidance
                field="this name"
                description="Name must be 1–200 characters. It is only a label for you."
                example="Family recovery plan"
                result="You can recognise this switch in your dashboard."
              />
            </div>
            <fieldset className="space-y-3">
              <legend className="text-sm font-medium">Release mode</legend>
              <label className="flex items-start gap-2 text-sm">
                <input
                  type="radio"
                  name="mode"
                  value="asymmetric_key"
                  checked={values.mode === 'asymmetric_key'}
                  onChange={() => onValuesChange({ ...values, mode: 'asymmetric_key' })}
                />
                <span>
                  <span className="font-medium">Release an encryption key</span>
                  <span className="block text-xs text-[var(--color-muted-foreground)]">
                    Recipients unlock material they already hold.
                  </span>
                </span>
              </label>
              <label className="flex items-start gap-2 text-sm">
                <input
                  type="radio"
                  name="mode"
                  value="direct_delivery"
                  checked={values.mode === 'direct_delivery'}
                  onChange={() => onValuesChange({ ...values, mode: 'direct_delivery' })}
                />
                <span>
                  <span className="font-medium">Deliver the sealed message directly</span>
                  <span className="block text-xs text-[var(--color-muted-foreground)]">
                    Recipients receive the sealed message through their configured delivery channel.
                  </span>
                </span>
              </label>
              <FieldGuidance
                field="release mode"
                description="Asymmetric key means recipients receive the encryption key to unlock material they already hold; use it when the payload itself lives elsewhere. Direct delivery means the sealed message is delivered to recipients directly."
                example="Direct delivery"
                result={
                  values.mode === 'asymmetric_key'
                    ? 'Recipients receive the key, not material stored elsewhere.'
                    : 'Recipients receive the sealed message directly.'
                }
              />
            </fieldset>
            <div className="grid gap-6 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="heartbeat-interval">Heartbeat interval (hours)</Label>
                <Input
                  id="heartbeat-interval"
                  name="heartbeatIntervalHours"
                  type="number"
                  min="24"
                  max="2160"
                  value={values.heartbeatIntervalHours}
                  onChange={event =>
                    onValuesChange({ ...values, heartbeatIntervalHours: event.target.value })
                  }
                  required
                />
                <FieldGuidance
                  field="heartbeat interval"
                  description="Choose 24–2160 hours. The default is 168 hours: how often the owner must check in. Each check-in resets the next deadline to now plus this interval."
                  example="168 hours (7 days)"
                  result={`The next deadline moves to ${values.heartbeatIntervalHours} hours after each check-in.`}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="grace-window">Grace window (hours)</Label>
                <Input
                  id="grace-window"
                  name="graceWindowHours"
                  type="number"
                  min="2"
                  value={values.graceWindowHours}
                  onChange={event =>
                    onValuesChange({ ...values, graceWindowHours: event.target.value })
                  }
                  required
                />
                <FieldGuidance
                  field="grace window"
                  description="Choose at least 2 hours. The default is 24 hours. After a missed deadline, reminders escalate and the owner can still check in to cancel; only after grace expires does release trigger."
                  example="24 hours (1 day)"
                  result={`Release cannot trigger until ${values.graceWindowHours} hours after a missed deadline.`}
                />
              </div>
            </div>
            <fieldset className="space-y-3">
              <legend className="text-sm font-medium">Release policy</legend>
              <label className="flex items-start gap-2 text-sm">
                <input
                  type="radio"
                  name="releasePolicy"
                  value="fail_safe"
                  checked={values.releasePolicy === 'fail_safe'}
                  onChange={() => onValuesChange({ ...values, releasePolicy: 'fail_safe' })}
                />
                <span>
                  <span className="font-medium">Fail safe</span>
                  <span className="block text-xs text-[var(--color-muted-foreground)]">
                    Hold delivery when the service is uncertain.
                  </span>
                </span>
              </label>
              <label className="flex items-start gap-2 text-sm">
                <input
                  type="radio"
                  name="releasePolicy"
                  value="fail_deadly"
                  checked={values.releasePolicy === 'fail_deadly'}
                  onChange={() => onValuesChange({ ...values, releasePolicy: 'fail_deadly' })}
                />
                <span>
                  <span className="font-medium">Fail deadly</span>
                  <span className="block text-xs text-[var(--color-muted-foreground)]">
                    Release even when the service is uncertain.
                  </span>
                </span>
              </label>
              <FieldGuidance
                field="release policy"
                description="Fail-safe is the default and holds delivery during database or clock uncertainty. Fail-deadly releases even when uncertain; it requires typed confirmation at arm time and carries a higher availability risk."
                example="Fail safe"
                result={
                  values.releasePolicy === 'fail_safe'
                    ? 'Delivery pauses rather than risking a false release during uncertainty.'
                    : 'Delivery prioritises release even when the service is uncertain.'
                }
              />
            </fieldset>
            <div className="space-y-2">
              <label className="flex items-start gap-2 text-sm">
                <input
                  name="dryRun"
                  type="checkbox"
                  checked={values.dryRun}
                  onChange={event => onValuesChange({ ...values, dryRun: event.target.checked })}
                />
                <span className="font-medium">Run a delivery test</span>
              </label>
              <FieldGuidance
                field="dry run"
                description="Dry run means deliveries are marked as tests and no real payload is released."
                example="Enabled while reviewing a new switch"
                result={
                  values.dryRun
                    ? 'A trigger sends marked test deliveries without releasing a real payload.'
                    : 'A trigger uses the configured release path.'
                }
              />
            </div>
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
      <SwitchOutcomePreview
        heartbeatIntervalHours={Number(values.heartbeatIntervalHours)}
        graceWindowHours={Number(values.graceWindowHours)}
        mode={values.mode}
        releasePolicy={values.releasePolicy}
        dryRun={values.dryRun}
      />
    </div>
  );
}
