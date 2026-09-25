import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
export { FieldGuidance } from '@/components/ui/field-guidance';

export const releaseModes = ['asymmetric_key', 'direct_delivery'] as const;
export const releasePolicies = ['fail_safe', 'fail_deadly'] as const;
export type ReleaseMode = (typeof releaseModes)[number];
export type ReleasePolicy = (typeof releasePolicies)[number];

type ScheduleInput = {
  readonly now: Date;
  readonly heartbeatIntervalHours: number;
  readonly graceWindowHours: number;
};

type OutcomePreviewProps = Omit<ScheduleInput, 'now'> & {
  readonly mode: ReleaseMode;
  readonly releasePolicy: ReleasePolicy;
  readonly dryRun: boolean;
};

const dateTimeFormatter = new Intl.DateTimeFormat(undefined, {
  dateStyle: 'medium',
  timeStyle: 'short',
});

const deliveryResults: Record<ReleaseMode, string> = {
  asymmetric_key: 'Recipients receive the encryption key to unlock material they already hold.',
  direct_delivery: 'The sealed message is delivered directly to recipients.',
};

const policyResults: Record<ReleasePolicy, string> = {
  fail_safe: 'Fail-safe holds delivery while the database or clock is uncertain.',
  fail_deadly: 'Fail-deadly releases even when the service is uncertain.',
};

export function calculatePreviewSchedule({
  now,
  heartbeatIntervalHours,
  graceWindowHours,
}: ScheduleInput): { readonly nextDeadline: Date; readonly releaseAt: Date } {
  const nextDeadline = new Date(now.getTime() + heartbeatIntervalHours * 60 * 60 * 1000);
  const releaseAt = new Date(nextDeadline.getTime() + graceWindowHours * 60 * 60 * 1000);
  return { nextDeadline, releaseAt };
}

export function SwitchOutcomePreview({
  heartbeatIntervalHours,
  graceWindowHours,
  mode,
  releasePolicy,
  dryRun,
}: OutcomePreviewProps) {
  const hoursAreValid =
    Number.isFinite(heartbeatIntervalHours) &&
    Number.isFinite(graceWindowHours) &&
    heartbeatIntervalHours > 0 &&
    graceWindowHours > 0;
  const schedule = hoursAreValid
    ? calculatePreviewSchedule({
        now: new Date(),
        heartbeatIntervalHours,
        graceWindowHours,
      })
    : null;

  return (
    <Card className="lg:sticky lg:top-8">
      <CardHeader>
        <CardTitle id="what-happens-next">What happens next</CardTitle>
        <CardDescription>
          Dates use your current local time and update as you change the form.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <section
          aria-labelledby="what-happens-next"
          aria-live="polite"
          className="space-y-4 text-sm"
        >
          <p>
            Check in every {heartbeatIntervalHours} hours. Each check-in resets the next deadline to
            now plus that interval.
          </p>
          {schedule ? (
            <ol className="space-y-3 border-l-2 border-[var(--color-primary)] pl-4">
              <li>
                <p className="font-medium">Missed deadline</p>
                <time dateTime={schedule.nextDeadline.toISOString()}>
                  {dateTimeFormatter.format(schedule.nextDeadline)}
                </time>
              </li>
              <li>
                <p className="font-medium">Grace period</p>
                <p>
                  After the missed deadline, a {graceWindowHours}-hour grace window starts.
                  Reminders escalate, and a check-in still cancels release.
                </p>
              </li>
              <li>
                <p className="font-medium">Release</p>
                <time dateTime={schedule.releaseAt.toISOString()}>
                  {dateTimeFormatter.format(schedule.releaseAt)}
                </time>
              </li>
            </ol>
          ) : (
            <p>Enter positive hour values to calculate the missed-deadline and release times.</p>
          )}
          <p>{deliveryResults[mode]}</p>
          <p>{policyResults[releasePolicy]}</p>
          <p>
            {dryRun
              ? 'Dry run is on: test deliveries are marked as tests and no real payload is released.'
              : 'Dry run is off: a triggered release uses the configured delivery path.'}
          </p>
        </section>
      </CardContent>
    </Card>
  );
}
