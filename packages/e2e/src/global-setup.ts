import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { GenericContainer, type StartedTestContainer } from 'testcontainers';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { migrate } from '../../db/dist/migrate.js';
import { seed } from '../../db/dist/seed.js';

const { Pool } = pg;
const root = fileURLToPath(new URL('../../../', import.meta.url));
const setupToken = 'e2e-bootstrap-token-1234567890';

function start(command: string, args: readonly string[], env: NodeJS.ProcessEnv): ChildProcess {
  return spawn(command, args, { cwd: root, env, stdio: 'pipe' });
}

async function waitFor(url: string): Promise<void> {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const response = await fetch(url).catch(() => null);
    if (response?.ok) return;
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error(`Timed out waiting for ${url}`);
}

async function stop(process: ChildProcess): Promise<void> {
  if (process.exitCode !== null) return;
  process.kill('SIGTERM');
  await once(process, 'exit');
}

export default async function globalSetup(): Promise<() => Promise<void>> {
  const database: StartedPostgreSqlContainer = await new PostgreSqlContainer(
    'postgres:17-alpine',
  ).start();
  const connectionString = database.getConnectionUri();
  await migrate({ connectionString });
  await seed({ connectionString });
  const pool = new Pool({ connectionString });
  await pool.query(
    `INSERT INTO app_config (key, value, updated_at) VALUES ('setup_token_hash',$1,clock_timestamp())
     ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, updated_at=clock_timestamp()`,
    [createHash('sha256').update(setupToken, 'utf8').digest('hex')],
  );
  await pool.end();

  const mailpit: StartedTestContainer = await new GenericContainer('axllent/mailpit:v1.27.4')
    .withExposedPorts(1025, 8025)
    .start();
  const mailpitApiUrl = `http://${mailpit.getHost()}:${mailpit.getMappedPort(8025)}`;
  const runtimeDir = fileURLToPath(new URL('../test-results', import.meta.url));
  mkdirSync(runtimeDir, { recursive: true });
  writeFileSync(
    `${runtimeDir}/e2e-runtime.json`,
    `${JSON.stringify({ databaseUrl: connectionString, mailpitApiUrl })}\n`,
  );

  const api = start(process.execPath, ['apps/api/dist/main.js'], {
    ...process.env,
    DATABASE_URL: connectionString,
    MASTER_KEY: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    PORT: '3001',
    HOST: '127.0.0.1',
    TICK_INTERVAL_SEC: '1',
    SMTP_HOST: mailpit.getHost(),
    SMTP_PORT: String(mailpit.getMappedPort(1025)),
    SMTP_FROM: 'vault@heartbeat-vault.test',
  });
  await waitFor('http://127.0.0.1:3001/api/health');
  const web = start(
    'pnpm',
    ['--filter', '@heartbeat-vault/web', 'exec', 'vite', '--host', '127.0.0.1', '--port', '5174'],
    { ...process.env, VITE_API_PROXY_TARGET: 'http://127.0.0.1:3001' },
  );
  await waitFor('http://127.0.0.1:5174');

  return async () => {
    await stop(web);
    await stop(api);
    await mailpit.stop();
    await database.stop();
  };
}
