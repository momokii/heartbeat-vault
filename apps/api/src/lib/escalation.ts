// Escalation stage computation (T4.3) — pure functions over a switch row.
//
// Stage ladder (DESIGN §5 defaults, generalized as fractions of the interval):
//   normal   : before next_deadline
//   reminder : at next_deadline
//   warning  : deadline + 25% of interval
//   pending  : deadline + 50% of interval
//   fire_due : deadline + 50% of interval + FIRE_LAG (1 day) → delivery queued
//   release  : fire + CANCEL_WINDOW (48h) → payload released unless cancelled
// DST-safe: all math is absolute UTC epoch arithmetic; wall-clock zones are
// presentation-only.

export type EscalationStage =
  'normal' | 'reminder' | 'warning' | 'pending' | 'fire_due' | 'released';

export type EscalationInput = {
  readonly status: string;
  readonly nextDeadline: Date;
  readonly intervalMs: number;
};

export type EscalationOutcome = {
  readonly stage: EscalationStage;
  readonly stageAt: Date;
  readonly fireAt: Date;
  readonly releaseAt: Date;
};

export const WARNING_FRACTION = 0.25;
export const PENDING_FRACTION = 0.5;
export const FIRE_LAG_MS = 24 * 60 * 60 * 1000;
export const CANCEL_WINDOW_MS = 48 * 60 * 60 * 1000;

export function computeEscalation(input: EscalationInput, now: Date): EscalationOutcome {
  const deadlineMs = input.nextDeadline.getTime();
  const warningAt = new Date(deadlineMs + input.intervalMs * WARNING_FRACTION);
  const pendingAt = new Date(deadlineMs + input.intervalMs * PENDING_FRACTION);
  const fireAt = new Date(pendingAt.getTime() + FIRE_LAG_MS);
  const releaseAt = new Date(fireAt.getTime() + CANCEL_WINDOW_MS);

  let stage: EscalationStage;
  let stageAt: Date;
  if (now.getTime() >= releaseAt.getTime()) {
    stage = 'released';
    stageAt = releaseAt;
  } else if (now.getTime() >= fireAt.getTime()) {
    stage = 'fire_due';
    stageAt = fireAt;
  } else if (now.getTime() >= pendingAt.getTime()) {
    stage = 'pending';
    stageAt = pendingAt;
  } else if (now.getTime() >= warningAt.getTime()) {
    stage = 'warning';
    stageAt = warningAt;
  } else if (now.getTime() >= deadlineMs) {
    stage = 'reminder';
    stageAt = input.nextDeadline;
  } else {
    stage = 'normal';
    stageAt = input.nextDeadline;
  }
  return { stage, stageAt, fireAt, releaseAt };
}
