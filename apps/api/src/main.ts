import { randomUUID } from 'node:crypto';
import pg from 'pg';
import type { Pool } from 'pg';
import { buildServer } from './server.js';
import { checkClockSkew, runSchedulerTick, TICK_INTERVAL_SEC_DEFAULT } from './lib/downtime.js';
import { claimJob, failJob, processJob, reapExpiredLeases } from './lib/trigger-engine.js';
import { deliverPendingDeliveries } from './channels/dispatch.js';
import { createConfiguredChannelRegistry } from './channels/registry.js';
import type { ChannelRegistry } from './channels/types.js';

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function configuredPort(): number {
  const raw = process.env['PORT'] ?? '3000';
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('PORT must be an integer between 1 and 65535');
  }
  return port;
}

function configuredIntegerEnvironment(
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return value;
}

// Cycle order is a safety contract, not preference: compensate for outages
// and materialize before working jobs, and hold everything when the host
// clock diverges from Postgres beyond the skew budget (ADR-004: never guess).
async function runSchedulerCycle(
  pool: Pool,
  registry: ChannelRegistry,
  workerId: string,
  tickIntervalSec: number,
  clockSkewBudgetMs: number,
): Promise<void> {
  const { uncertain } = await checkClockSkew(pool, clockSkewBudgetMs);
  if (uncertain) {
    process.stderr.write('scheduler tick held: clock skew beyond budget\n');
    return;
  }
  const now = new Date();
  await runSchedulerTick(pool, workerId, now, tickIntervalSec);
  await reapExpiredLeases(pool, now);
  for (;;) {
    const job = await claimJob(pool, workerId, now);
    if (job === null) break;
    try {
      await processJob(pool, job, workerId);
    } catch (error) {
      await failJob(
        pool,
        job.id,
        workerId,
        error instanceof Error ? error.message : 'unknown trigger job failure',
      );
    }
  }
  await deliverPendingDeliveries(pool, registry, workerId, now);
}

export async function startServer(): Promise<void> {
  const pool = new pg.Pool({ connectionString: requiredEnvironment('DATABASE_URL') });
  const app = await buildServer(pool);
  let stopping = false;

  const registry = createConfiguredChannelRegistry(process.env);
  const tickIntervalSec = configuredIntegerEnvironment(
    'TICK_INTERVAL_SEC',
    TICK_INTERVAL_SEC_DEFAULT,
    1,
    86_400,
  );
  const clockSkewBudgetMs = configuredIntegerEnvironment(
    'CLOCK_SKEW_BUDGET_MS',
    5_000,
    0,
    3_600_000,
  );
  const workerId = randomUUID();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let inFlight: Promise<void> = Promise.resolve();

  function scheduleNextTick(): void {
    if (stopping) return;
    timer = setTimeout(() => {
      inFlight = runSchedulerCycle(pool, registry, workerId, tickIntervalSec, clockSkewBudgetMs)
        .catch((error: unknown) => {
          process.stderr.write(
            `scheduler tick failed: ${error instanceof Error ? error.message : 'unknown error'}\n`,
          );
        })
        .finally(() => {
          scheduleNextTick();
        });
    }, tickIntervalSec * 1000);
  }

  scheduleNextTick();

  async function stop(exitCode: number): Promise<void> {
    if (stopping) return;
    stopping = true;
    if (timer !== null) clearTimeout(timer);
    await inFlight;
    await app.close();
    await pool.end();
    process.exitCode = exitCode;
  }

  process.once('SIGTERM', () => void stop(0));
  process.once('SIGINT', () => void stop(0));

  try {
    await pool.query('SELECT 1');
    await app.listen({ host: process.env['HOST'] ?? '0.0.0.0', port: configuredPort() });
  } catch (error) {
    await stop(1);
    throw error;
  }
}

const isMain =
  process.argv[1] !== undefined && new URL(`file://${process.argv[1]}`).href === import.meta.url;

if (isMain) {
  startServer().catch(error => {
    process.stderr.write(
      `API startup failed: ${error instanceof Error ? error.message : 'unknown error'}\n`,
    );
    process.exitCode = 1;
  });
}
