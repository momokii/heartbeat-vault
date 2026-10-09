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
vi.mock('./reminders/delivery.js', async () => ({
  ...(await vi.importActual<typeof import('./reminders/delivery.js')>('./reminders/delivery.js')),
}));
vi.mock('./channels/registry.js', () => ({
  createConfiguredChannelRegistry: mocks.createConfiguredChannelRegistry,
}));
vi.mock('./reminders/index.js', async () => {
  const actual =
    await vi.importActual<typeof import('./reminders/index.js')>('./reminders/index.js');
  return { ...actual, materializeOwnerReminder: mocks.materializeOwnerReminder };
});

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

  it('keeps lease reaping and release processing alive when the email provider hangs', async () => {
    const { runSchedulerCycle } = await import('./main.js');
    const pool = new Pool();
    const emailChannel = { send: vi.fn().mockImplementation(() => new Promise(() => undefined)) };
    const registry = { get: vi.fn().mockReturnValue(emailChannel), names: ['email'] };
    const client = {
      query: vi.fn().mockImplementation((text: string) => {
        if (text.includes('SELECT id, switch_id, owner_email')) {
          const claim = client.query.mock.calls.filter(([query]) =>
            String(query).includes('SELECT id, switch_id, owner_email'),
          ).length;
          if (claim > 1) return Promise.resolve({ rows: [] });
          return Promise.resolve({
            rows: [
              {
                id: '11111111-1111-4111-8111-111111111111',
                switch_id: SWITCH_ID,
                owner_email: 'owner@example.test',
                deadline_at: DEADLINE,
                stage: 'reminder',
                channel: 'email',
                idempotency_key: 'reminder-key',
              },
            ],
          });
        }
        if (text.includes('INSERT INTO audit_log')) return Promise.resolve({ rows: [{ id: 1 }] });
        return Promise.resolve({ rows: [] });
      }),
      release: vi.fn(),
    };
    vi.spyOn(pool, 'connect').mockImplementation(() => Promise.resolve(client));
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
    mocks.deliverPendingDeliveries.mockResolvedValue({ sent: 0, retried: 0, dead: 0 });
    mocks.materializeOwnerReminder.mockResolvedValue(undefined);
    vi.useFakeTimers();
    vi.setSystemTime(FIXED_NOW);

    const cycle = runSchedulerCycle(pool, registry, 'worker-1', 60, 5_000);
    await vi.waitFor(() => expect(emailChannel.send).toHaveBeenCalledTimes(1));
    await vi.advanceTimersByTimeAsync(30_001);
    await cycle;

    expect(mocks.reapExpiredLeases).toHaveBeenCalledWith(pool, expect.any(Date));
    expect(mocks.processJob).toHaveBeenCalledWith(pool, releaseJob, 'worker-1');
    expect(mocks.deliverPendingDeliveries).toHaveBeenCalledWith(
      pool,
      registry,
      'worker-1',
      expect.any(Date),
    );
    expect(client.query).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE reminder_jobs'),
      expect.arrayContaining(['11111111-1111-4111-8111-111111111111']),
    );
    expect(query).toHaveBeenCalled();
    await pool.end();
  });

  it('redacts scheduler delivery errors before writing them to stderr', async () => {
    const { runSchedulerCycle } = await import('./main.js');
    const pool = new Pool();
    const registry = { get: vi.fn().mockReturnValue({ send: vi.fn() }), names: ['email'] };
    vi.spyOn(pool, 'query').mockImplementation(() =>
      Promise.resolve({
        rows: [],
        command: 'SELECT',
        rowCount: 0,
        oid: 0,
        fields: [],
      }),
    );
    const client = {
      query: vi.fn().mockImplementation((text: string) => {
        if (text === 'BEGIN')
          return Promise.reject(
            new Error(
              'switch 22222222-2222-4222-8222-222222222222: smtp://mail.example.test failed for owner@example.com token abcdef0123456789abcdef0123456789. DETAIL: Key (email)=(owner@example.com) already exists',
            ),
          );
        return Promise.resolve({ rows: [] });
      }),
      release: vi.fn(),
    };
    vi.spyOn(pool, 'connect').mockImplementation(() => Promise.resolve(client));
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    mocks.checkClockSkew.mockResolvedValue({ uncertain: false, skewMs: 0 });
    mocks.runSchedulerTick.mockResolvedValue(0);
    mocks.materializeOwnerReminder.mockResolvedValue(undefined);
    mocks.reapExpiredLeases.mockResolvedValue(0);
    mocks.claimJob.mockResolvedValue(null);
    mocks.deliverPendingDeliveries.mockResolvedValue({ sent: 0, retried: 0, dead: 0 });
    vi.useFakeTimers();
    vi.setSystemTime(FIXED_NOW);

    await runSchedulerCycle(pool, registry, 'worker-1', 60, 5_000);

    const output = stderr.mock.calls.map(([value]) => String(value)).join('');
    expect(output).toContain('switch 22222222-2222-4222-8222-222222222222');
    expect(output).not.toContain('owner@example.com');
    expect(output).not.toContain('mail.example.test');
    expect(output).not.toContain('abcdef0123456789abcdef0123456789');
    expect(output).not.toContain('DETAIL: Key');
    stderr.mockRestore();
    await pool.end();
  });
});
