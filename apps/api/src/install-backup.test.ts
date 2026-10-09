import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Pool } from 'pg';
import { randomBytes } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import {
  cleanupHarness,
  createHarness,
  encryptBackup,
  makePlainBackup,
  runInstaller,
  TEST_KEY,
} from './install-backup.test-support.js';
const POSTGRES_IMAGE = 'postgres:17-alpine';
const execFileAsync = promisify(execFile);

let database: StartedPostgreSqlContainer;
let pool: Pool;

describe('installer backup and restore safety', () => {
  beforeAll(async () => {
    const name = `heartbeat-restore-${randomBytes(6).toString('hex')}`;
    const user = `test_${randomBytes(5).toString('hex')}`;
    const password = randomBytes(18).toString('hex');
    database = await new PostgreSqlContainer(POSTGRES_IMAGE)
      .withName(name)
      .withDatabase(`restore_${randomBytes(5).toString('hex')}`)
      .withUsername(user)
      .withPassword(password)
      .withExposedPorts({ container: 5432, host: 25432 })
      .start();
    pool = new Pool({ connectionString: database.getConnectionUri() });
    const identity = await pool.query<{ current_database: string }>('SELECT current_database()');
    expect(identity.rows[0]?.current_database).toBe(database.getDatabase());
  }, 180000);

  afterAll(async () => {
    await pool.end();
    expect(pool.ended).toBe(true);
    await database.stop();
  });

  it('writes only an encrypted .enc backup and decrypts with BACKUP_ENCRYPTION_KEY', async () => {
    const root = await createHarness(database, TEST_KEY);
    try {
      const result = await runInstaller(root, ['backup'], {
        HV_DOCKER_LOG: join(root, 'docker.log'),
        HV_PSQL_INPUT: join(root, 'psql.sql'),
      });
      expect(result.status).toBe(0);
      const files = await readdir(join(root, 'backups'));
      expect(files).toHaveLength(1);
      expect(files[0]).toMatch(/\.sql\.gz\.enc$/);
      expect(files[0]).not.toMatch(/\.sql\.gz$/);
      const encrypted = join(root, 'backups', files[0] ?? '');
      const decrypted = join(root, 'decrypted.sql.gz');
      await execFileAsync(
        'openssl',
        [
          'enc',
          '-d',
          '-aes-256-cbc',
          '-pbkdf2',
          '-in',
          encrypted,
          '-out',
          decrypted,
          '-pass',
          'env:BACKUP_KEY_ENV',
        ],
        { env: { ...process.env, BACKUP_KEY_ENV: TEST_KEY } },
      );
      const plain = await execFileAsync('gzip', ['-cd', decrypted]);
      expect(plain.stdout).toContain('current_database');
    } finally {
      await cleanupHarness(root);
    }
  });

  it('refuses to create a backup when BACKUP_ENCRYPTION_KEY is missing', async () => {
    const root = await createHarness(database);
    try {
      const result = await runInstaller(root, ['backup'], {
        HV_DOCKER_LOG: join(root, 'docker.log'),
        HV_PSQL_INPUT: join(root, 'psql.sql'),
      });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toMatch(/BACKUP_ENCRYPTION_KEY/i);
      await expect(readdir(join(root, 'backups'))).rejects.toThrow();
    } finally {
      await cleanupHarness(root);
    }
  });

  it('restores only to an explicit isolated target after checking current_database()', async () => {
    const root = await createHarness(database, TEST_KEY);
    try {
      const encrypted = await encryptBackup(await makePlainBackup(root));
      const result = await runInstaller(root, ['restore', encrypted, '--yes'], {
        HV_DOCKER_LOG: join(root, 'docker.log'),
        HV_PSQL_INPUT: join(root, 'psql.sql'),
      });
      const log = await readFile(join(root, 'docker.log'), 'utf8');
      expect(result.status).toBe(0);
      expect(log).not.toMatch(/compose exec -T db/);
      expect(log).toMatch(/current_database/);
    } finally {
      await cleanupHarness(root);
    }
  });

  it('exits before touching any database when restore lacks --yes', async () => {
    const root = await createHarness(database, TEST_KEY);
    try {
      const encrypted = await encryptBackup(await makePlainBackup(root));
      const result = await runInstaller(root, ['restore', encrypted], {
        HV_DOCKER_LOG: join(root, 'docker.log'),
        HV_PSQL_INPUT: join(root, 'psql.sql'),
      });
      expect(result.status).toBe(2);
      await expect(readFile(join(root, 'docker.log'))).rejects.toThrow();
      expect(await readdir(root)).not.toContain('input.sql.gz');
    } finally {
      await cleanupHarness(root);
    }
  });

  it.each([
    ['success', {}],
    ['failure', { HV_FAIL_RESTORE: '1' }],
  ])('removes decrypted plaintext artifacts on %s', async (_outcome, extraEnv) => {
    const root = await createHarness(database, TEST_KEY);
    try {
      const encrypted = await encryptBackup(await makePlainBackup(root));
      await runInstaller(root, ['restore', encrypted, '--yes'], {
        HV_DOCKER_LOG: join(root, 'docker.log'),
        HV_PSQL_INPUT: join(root, 'psql.sql'),
        ...extraEnv,
      });
      expect(await readdir(root)).not.toContain('input.sql.gz');
    } finally {
      await cleanupHarness(root);
    }
  });

  it('removes decrypted plaintext artifacts when restore is interrupted', async () => {
    const root = await createHarness(database, TEST_KEY);
    try {
      const encrypted = await encryptBackup(await makePlainBackup(root));
      const child = spawn(join(root, 'install.sh'), ['restore', encrypted, '--yes'], {
        cwd: root,
        detached: true,
        env: {
          ...process.env,
          PATH: `${join(root, 'bin')}:${process.env['PATH']}`,
          HV_DOCKER_LOG: join(root, 'docker.log'),
          HV_PSQL_INPUT: join(root, 'psql.sql'),
          HV_BLOCK_RESTORE: '1',
        },
      });
      await new Promise(resolve => setTimeout(resolve, 250));
      const pid = child.pid;
      if (pid === undefined) throw new Error('Expected restore process to have a PID');
      try {
        process.kill(-pid, 'SIGTERM');
      } catch (error) {
        if (!(error instanceof Error) || !('code' in error) || error.code !== 'ESRCH') throw error;
      }
      await new Promise(resolve => child.once('close', resolve));
      expect(await readdir(root)).not.toContain('input.sql.gz');
    } finally {
      await cleanupHarness(root);
    }
  });

  it('does not allow the current restore path to target live Compose db service', async () => {
    const root = await createHarness(database);
    try {
      const result = await runInstaller(root, ['restore', await makePlainBackup(root), '--yes'], {
        HV_DOCKER_LOG: join(root, 'docker.log'),
        HV_PSQL_INPUT: join(root, 'psql.sql'),
      });
      const log = await readFile(join(root, 'docker.log'), 'utf8');
      expect(result.status).toBe(0);
      expect(log).not.toMatch(/compose exec -T db/);
    } finally {
      await cleanupHarness(root);
    }
  });
});
