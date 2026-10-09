import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Pool } from 'pg';
import { randomBytes } from 'node:crypto';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import {
  cleanupHarness,
  createHarness,
  encryptBackup,
  makePlainBackup,
  runInstaller,
  runInstallerWithInput,
  TEST_KEY,
} from './install-backup.test-support.js';
const POSTGRES_IMAGE = 'postgres:17-alpine';
const execFileAsync = promisify(execFile);

let database: StartedPostgreSqlContainer;
let pool: Pool;
let liveDatabase: StartedPostgreSqlContainer;
let livePool: Pool;
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
    liveDatabase = await new PostgreSqlContainer(POSTGRES_IMAGE)
      .withName(`heartbeat-live-${randomBytes(6).toString('hex')}`)
      .withDatabase(`live_${randomBytes(5).toString('hex')}`)
      .withUsername(`live_${randomBytes(5).toString('hex')}`)
      .withPassword(randomBytes(18).toString('hex'))
      .withExposedPorts({ container: 5432, host: 25433 })
      .start();
    pool = new Pool({ connectionString: database.getConnectionUri() });
    livePool = new Pool({ connectionString: liveDatabase.getConnectionUri() });
    await pool.query(
      "CREATE TABLE heartbeat_restore_target_marker (marker text PRIMARY KEY); INSERT INTO heartbeat_restore_target_marker VALUES ('heartbeat-vault-isolated-v1')",
    );
    const marker = await pool.query<{ marker: string }>(
      'SELECT marker FROM heartbeat_restore_target_marker',
    );
    expect(marker.rows[0]?.marker).toBe('heartbeat-vault-isolated-v1');
    const identity = await pool.query<{ current_database: string }>('SELECT current_database()');
    expect(identity.rows[0]?.current_database).toBe(database.getDatabase());
  }, 180000);

  afterAll(async () => {
    await pool.end();
    await livePool.end();
    expect(pool.ended).toBe(true);
    await database.stop();
    await liveDatabase.stop();
  });

  it('writes only an encrypted .enc backup and decrypts with BACKUP_ENCRYPTION_KEY', async () => {
    const root = await createHarness(database, TEST_KEY);
    try {
      const result = await runInstaller(root, ['backup'], {
        HV_DOCKER_LOG: join(root, 'docker.log'),
        HV_PSQL_INPUT: join(root, 'psql.sql'),
      });
      expect(result.status, result.stderr).toBe(0);
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

  it('restores destructive SQL into an installer-owned drill target and leaves live Compose DB untouched', async () => {
    const root = await createHarness(database, TEST_KEY);
    try {
      const marker = `drill-${randomBytes(8).toString('hex')}`;
      const encrypted = await encryptBackup(
        await makePlainBackup(
          root,
          `CREATE TABLE restore_drill_marker (value text PRIMARY KEY); INSERT INTO restore_drill_marker VALUES ('${marker}');`,
        ),
      );
      await livePool.query('DROP TABLE IF EXISTS restore_drill_marker');
      const result = await runInstaller(root, ['restore', '--drill', encrypted, '--yes'], {
        HV_DOCKER_LOG: join(root, 'docker.log'),
        HV_PSQL_INPUT: join(root, 'psql.sql'),
        HV_USE_REAL_DOCKER: '1',
        DOCKER_HOST: 'tcp://127.0.0.1:1',
        HV_KEEP_DRILL_TARGET: '1',
      });
      expect(result.status, result.stderr).toBe(0);
      const connection = result.stderr.match(
        /test-only drill target: container=(\S+) user=(\S+) database=(\S+)/,
      );
      const container = connection?.[1];
      try {
        expect(result.stderr).toContain('test-only');
        expect(connection).not.toBeNull();
        const user = connection?.[2];
        const targetDatabase = connection?.[3];
        if (container === undefined || user === undefined || targetDatabase === undefined) {
          throw new Error('Expected kept drill target connection details');
        }
        const markerResult = await execFileAsync('docker', [
          'exec',
          container,
          'psql',
          '-U',
          user,
          '-d',
          targetDatabase,
          '-Atqc',
          `SELECT value FROM restore_drill_marker WHERE value = '${marker}'`,
        ]);
        expect(markerResult.stdout.trim()).toBe(marker);
      } finally {
        if (container !== undefined) {
          await execFileAsync('docker', ['rm', '-f', container]);
          await expect(execFileAsync('docker', ['inspect', container])).rejects.toThrow();
        }
      }
      const liveMarker = await livePool.query(
        "SELECT to_regclass('public.restore_drill_marker') AS table_name",
      );
      expect(liveMarker.rows[0]?.table_name).toBeNull();
    } finally {
      await cleanupHarness(root);
    }
  });

  it('exits before touching any database when restore lacks --yes', async () => {
    const root = await createHarness(database, TEST_KEY);
    try {
      const encrypted = await encryptBackup(await makePlainBackup(root));
      const result = await runInstaller(root, ['restore', '--drill', encrypted], {
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
      await runInstaller(root, ['restore', '--drill', encrypted, '--yes'], {
        HV_DOCKER_LOG: join(root, 'docker.log'),
        HV_PSQL_INPUT: join(root, 'psql.sql'),
        HV_USE_REAL_DOCKER: '1',
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
      const child = spawn(join(root, 'install.sh'), ['restore', '--drill', encrypted, '--yes'], {
        cwd: root,
        detached: true,
        env: {
          ...process.env,
          PATH: `${join(root, 'crypto-bin')}:${process.env['PATH']}`,
          HV_DOCKER_LOG: join(root, 'docker.log'),
          HV_PSQL_INPUT: join(root, 'psql.sql'),
          HV_BLOCK_RESTORE: '1',
          HV_USE_REAL_DOCKER: '1',
          HV_DELAY_DECRYPTION: '1',
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
      await expect(readFile(encrypted)).resolves.toBeTruthy();
      expect(await readdir(root)).not.toContain('input.sql.gz');
    } finally {
      await cleanupHarness(root);
    }
  });

  it('preserves caller-supplied plaintext restore inputs', async () => {
    const root = await createHarness(database, TEST_KEY);
    try {
      const plain = await makePlainBackup(root);
      const result = await runInstaller(root, ['restore', '--drill', plain, '--yes'], {
        HV_USE_REAL_DOCKER: '1',
      });
      expect(result.status, result.stderr).toBe(0);
      await expect(readFile(plain)).resolves.toBeTruthy();
    } finally {
      await cleanupHarness(root);
    }
  });

  it('refuses live restore without the typed database confirmation', async () => {
    const root = await createHarness(database);
    try {
      const result = await runInstaller(
        root,
        ['restore', '--live', await makePlainBackup(root), '--yes'],
        { COMPOSE_FILE: '/tmp/attacker-compose.yml', COMPOSE_PROJECT_NAME: 'attacker' },
      );
      expect(result.status).toBe(2);
      expect(result.stderr).toMatch(/type.*database name|confirmation/i);
    } finally {
      await cleanupHarness(root);
    }
  });

  it('restores the confirmed database in a disposable Compose project despite hostile Compose env', async () => {
    const root = await createHarness(database);
    const project = `heartbeat-live-restore-${randomBytes(6).toString('hex')}`;
    const targetDatabase = `live_restore_${randomBytes(5).toString('hex')}`;
    const targetUser = `live_${randomBytes(5).toString('hex')}`;
    const targetPassword = randomBytes(18).toString('hex');
    const composeFile = join(root, 'docker-compose.yml');
    try {
      await writeFile(
        composeFile,
        `name: ${project}\nservices:\n  db:\n    image: postgres:17-alpine\n    environment:\n      POSTGRES_DB: ${targetDatabase}\n      POSTGRES_USER: ${targetUser}\n      POSTGRES_PASSWORD: ${targetPassword}\n    ports:\n      - "127.0.0.1::5432"\n`,
      );
      await writeFile(
        join(root, '.env'),
        `POSTGRES_USER=${targetUser}\nPOSTGRES_DB=${targetDatabase}\nPOSTGRES_PASSWORD=${targetPassword}\n`,
      );
      await execFileAsync('docker', ['compose', '-p', project, '-f', composeFile, 'up', '-d'], {
        cwd: root,
      });
      for (let attempt = 0; attempt < 60; attempt += 1) {
        try {
          await execFileAsync(
            'docker',
            [
              'compose',
              '-p',
              project,
              '-f',
              composeFile,
              'exec',
              '-T',
              'db',
              'psql',
              '-U',
              targetUser,
              '-d',
              targetDatabase,
              '-Atqc',
              'SELECT 1',
            ],
            { cwd: root },
          );
          break;
        } catch (error) {
          if (attempt === 59) throw error;
          await new Promise(resolve => setTimeout(resolve, 1000));
        }
      }
      const backup = await makePlainBackup(
        root,
        `DROP TABLE IF EXISTS live_restore_marker; CREATE TABLE live_restore_marker (value text PRIMARY KEY); INSERT INTO live_restore_marker VALUES ('live-${project}');`,
      );
      const result = await runInstallerWithInput(
        root,
        ['restore', '--live', backup, '--yes'],
        `${targetDatabase}\n`,
        {
          COMPOSE_FILE: '/tmp/attacker-compose.yml',
          COMPOSE_PROJECT_NAME: 'attacker',
          DOCKER_HOST: 'tcp://127.0.0.1:1',
          HV_USE_REAL_DOCKER: '1',
        },
      );
      expect(result.status, result.stderr).toBe(0);
      const portResult = await execFileAsync(
        'docker',
        ['compose', '-p', project, '-f', composeFile, 'port', 'db', '5432'],
        { cwd: root },
      );
      const port = portResult.stdout.trim().split(':').at(-1);
      if (port === undefined || port.length === 0) throw new Error('Expected disposable DB port');
      const targetPool = new Pool({
        host: '127.0.0.1',
        port: Number(port),
        database: targetDatabase,
        user: targetUser,
        password: targetPassword,
      });
      try {
        const marker = await targetPool.query<{ value: string }>(
          'SELECT value FROM live_restore_marker',
        );
        expect(marker.rows[0]?.value).toBe(`live-${project}`);
      } finally {
        await targetPool.end();
      }
    } finally {
      await execFileAsync(
        'docker',
        ['compose', '-p', project, '-f', composeFile, 'down', '-v', '--remove-orphans'],
        {
          cwd: root,
        },
      ).catch(() => undefined);
      const remaining = await execFileAsync(
        'docker',
        ['compose', '-p', project, '-f', composeFile, 'ps', '-q'],
        { cwd: root },
      ).catch(() => ({ stdout: '' }));
      expect(remaining.stdout.trim()).toBe('');
      await cleanupHarness(root);
    }
  });

  it('rejects arbitrary restore target flags and compose override smuggling', async () => {
    const root = await createHarness(database);
    try {
      const result = await runInstaller(
        root,
        [
          'restore',
          '--drill',
          await makePlainBackup(root),
          '--yes',
          '--target-host',
          '127.0.0.1',
          '--target-port',
          '25432',
        ],
        { COMPOSE_FILE: '/tmp/attacker-compose.yml', COMPOSE_PROJECT_NAME: 'attacker' },
      );
      expect(result.status).toBe(2);
      expect(result.stderr).toMatch(/unexpected argument|target/i);
    } finally {
      await cleanupHarness(root);
    }
  });
});
