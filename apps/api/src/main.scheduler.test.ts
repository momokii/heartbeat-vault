import { Pool } from 'pg';
import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  checkClockSkew: vi.fn(),
  runSchedulerTick: vi.fn(),
  reapExpiredLeases: vi.fn(),
  claimJob: vi.fn(),
  processJob: vi.fn(),
  failJob: vi.fn(),
  deliverPendingDeliveries: vi.fn(),
  deliverPendingOwnerReminders: vi.fn(),
  createReminderEmailSender: vi.fn(),
  createConfiguredChannelRegistry: vi.fn(),
  materializeOwnerReminder: vi.fn(),
  sanitizeReminderError: (error: unknown) =>
    error instanceof Error ? error.message : 'unknown error',
}));

vi.mock('./server.js', () => ({ buildServer: vi.fn() }));
vi.mock('./lib/downtime.js', () => ({
  checkClockSkew: mocks.checkClockSkew,
  runSchedulerTick: mocks.runSchedulerTick,
  TICK_INTERVAL_SEC_DEFAULT: 60,
}));
vi.mock('./lib/trigger-engine.js', () => ({
  claimJob: mocks.claimJob,
  failJob: mocks.failJob,
  processJob: mocks.processJob,
  reapExpiredLeases: mocks.reapExpiredLeases,
}));
vi.mock('./channels/dispatch.js', () => ({
  deliverPendingDeliveries: mocks.deliverPendingDeliveries,
}));
vi.mock('./reminders/delivery.js', () => ({
  createReminderEmailSender: mocks.createReminderEmailSender,
  deliverPendingOwnerReminders: mocks.deliverPendingOwnerReminders,
}));
vi.mock('./channels/registry.js', () => ({
  createConfiguredChannelRegistry: mocks.createConfiguredChannelRegistry,
}));
vi.mock('./reminders/index.js', () => ({
  materializeOwnerReminder: mocks.materializeOwnerReminder,
  sanitizeReminderError: mocks.sanitizeReminderError,
}));

const FIXED_NOW = new Date('2026-10-01T00:00:00.000Z');
const SWITCH_ID = '22222222-2222-4222-8222-222222222222';
const DEADLINE = new Date('2026-09-30T00:00:00.000Z');

describe('scheduler owner reminders', () => {
  afterEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.useRealTimers();
  });

  it('materializes due stages without blocking release processing when reminder persistence fails', async () => {
    const { runSchedulerCycle } = await import('./main.js');
    const pool = new Pool();
    const registry = { get: () => undefined, names: [] };
    const query = vi.spyOn(pool, 'query').mockImplementation(() =>
      Promise.resolve({
        rows: [
          { switchId: SWITCH_ID, deadlineAt: DEADLINE, stage: 'reminder' },
          { switchId: SWITCH_ID, deadlineAt: DEADLINE, stage: 'warning' },
        ],
        command: 'SELECT',
        rowCount: 2,
        oid: 0,
        fields: [],
      }),
    );
    mocks.checkClockSkew.mockResolvedValue({ uncertain: false, skewMs: 0 });
    mocks.runSchedulerTick.mockResolvedValue(0);
    mocks.reapExpiredLeases.mockResolvedValue(0);
    mocks.claimJob.mockResolvedValue(null);
    mocks.deliverPendingDeliveries.mockResolvedValue({ sent: 0, retried: 0, dead: 0 });
    mocks.deliverPendingOwnerReminders.mockResolvedValue({ sent: 0, failed: 0 });
    mocks.materializeOwnerReminder.mockRejectedValue(new Error('reminder database unavailable'));
    vi.useFakeTimers();
    vi.setSystemTime(FIXED_NOW);

    await runSchedulerCycle(pool, registry, 'worker-1', 60, 5_000);

    expect(query).toHaveBeenCalledWith(expect.stringContaining('switches'), [FIXED_NOW]);
    expect(mocks.materializeOwnerReminder).toHaveBeenCalledTimes(2);
    expect(mocks.processJob).not.toHaveBeenCalled();
    expect(mocks.reapExpiredLeases).toHaveBeenCalledWith(pool, expect.any(Date));
    expect(mocks.claimJob).toHaveBeenCalledWith(pool, 'worker-1', expect.any(Date));
    expect(mocks.deliverPendingDeliveries).toHaveBeenCalledWith(
      pool,
      registry,
      'worker-1',
      expect.any(Date),
    );
    await pool.end();
  });

  it('keeps lease reaping and release processing alive when reminder delivery times out', async () => {
    const { runSchedulerCycle } = await import('./main.js');
    const pool = new Pool();
    const emailChannel = { send: vi.fn() };
    const registry = { get: vi.fn().mockReturnValue(emailChannel), names: ['email'] };
    const query = vi.spyOn(pool, 'query').mockImplementation(() =>
      Promise.resolve({
        rows: [],
        command: 'SELECT',
        rowCount: 0,
        oid: 0,
        fields: [],
      }),
    );
    const releaseJob = {
      id: 7,
      switchId: SWITCH_ID,
      state: 'running',
      attempts: 1,
      maxAttempts: 5,
      ownerId: 'worker-1',
      leaseExpires: FIXED_NOW,
      idempotencyKey: 'switch:7',
    };
    mocks.checkClockSkew.mockResolvedValue({ uncertain: false, skewMs: 0 });
    mocks.runSchedulerTick.mockResolvedValue(0);
    mocks.reapExpiredLeases.mockResolvedValue(0);
    mocks.claimJob.mockResolvedValueOnce(releaseJob).mockResolvedValueOnce(null);
    mocks.processJob.mockResolvedValue(undefined);
    mocks.createReminderEmailSender.mockReturnValue(vi.fn());
    mocks.deliverPendingOwnerReminders.mockResolvedValue({ sent: 0, failed: 1 });
    mocks.deliverPendingDeliveries.mockResolvedValue({ sent: 0, retried: 0, dead: 0 });
    mocks.materializeOwnerReminder.mockResolvedValue(undefined);
    vi.useFakeTimers();
    vi.setSystemTime(FIXED_NOW);

    await runSchedulerCycle(pool, registry, 'worker-1', 60, 5_000);

    expect(mocks.reapExpiredLeases).toHaveBeenCalledWith(pool, expect.any(Date));
    expect(mocks.processJob).toHaveBeenCalledWith(pool, releaseJob, 'worker-1');
    expect(mocks.deliverPendingDeliveries).toHaveBeenCalledWith(
      pool,
      registry,
      'worker-1',
      expect.any(Date),
    );
    expect(query).toHaveBeenCalled();
    await pool.end();
  });
});
