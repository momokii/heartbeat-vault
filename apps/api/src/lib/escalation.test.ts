import { describe, it, expect } from 'vitest';
import { computeEscalation, CANCEL_WINDOW_MS, FIRE_LAG_MS } from './escalation.js';

const DEADLINE = new Date('2026-09-01T00:00:00.000Z');
const FOURTEEN_DAYS_MS = 14 * 24 * 60 * 60 * 1000;

function at(offsetMs: number): Date {
  return new Date(DEADLINE.getTime() + offsetMs);
}

describe('computeEscalation', () => {
  it('normal before deadline', () => {
    const out = computeEscalation(
      { status: 'active', nextDeadline: DEADLINE, intervalMs: FOURTEEN_DAYS_MS },
      at(-60_000),
    );
    expect(out.stage).toBe('normal');
  });

  it('reminder at deadline, warning at +25%, pending at +50%', () => {
    const base = { status: 'active', nextDeadline: DEADLINE, intervalMs: FOURTEEN_DAYS_MS };
    expect(computeEscalation(base, DEADLINE).stage).toBe('reminder');
    expect(computeEscalation(base, at(FOURTEEN_DAYS_MS * 0.25)).stage).toBe('warning');
    expect(computeEscalation(base, at(FOURTEEN_DAYS_MS * 0.5)).stage).toBe('pending');
  });

  it('fire_due after pending + 24h; released after + 48h cancel window', () => {
    const base = { status: 'active', nextDeadline: DEADLINE, intervalMs: FOURTEEN_DAYS_MS };
    const fireAt = at(FOURTEEN_DAYS_MS * 0.5 + FIRE_LAG_MS);
    expect(computeEscalation(base, fireAt).stage).toBe('fire_due');
    expect(computeEscalation(base, new Date(fireAt.getTime() - 1)).stage).toBe('pending');
    const releaseAt = new Date(fireAt.getTime() + CANCEL_WINDOW_MS);
    expect(computeEscalation(base, releaseAt).stage).toBe('released');
    expect(computeEscalation(base, new Date(releaseAt.getTime() - 1)).stage).toBe('fire_due');
  });

  it('stage boundaries are exact (fraction math does not drift)', () => {
    const base = { status: 'active', nextDeadline: DEADLINE, intervalMs: FOURTEEN_DAYS_MS };
    const out = computeEscalation(base, DEADLINE);
    expect(out.fireAt.getTime()).toBe(DEADLINE.getTime() + FOURTEEN_DAYS_MS * 0.5 + FIRE_LAG_MS);
    expect(out.releaseAt.getTime()).toBe(
      DEADLINE.getTime() + FOURTEEN_DAYS_MS * 0.5 + FIRE_LAG_MS + CANCEL_WINDOW_MS,
    );
  });

  it('short interval keeps ordering warning < pending < fire < release', () => {
    const oneHour = 60 * 60 * 1000;
    const out = computeEscalation(
      { status: 'active', nextDeadline: DEADLINE, intervalMs: oneHour },
      DEADLINE,
    );
    expect(out.fireAt.getTime()).toBeGreaterThan(at(oneHour * 0.5).getTime());
    expect(out.releaseAt.getTime()).toBeGreaterThan(out.fireAt.getTime());
  });
});
