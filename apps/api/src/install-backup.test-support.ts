import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const installScript = join(repoRoot, 'install.sh');
const fakeDockerScript = `#!/bin/sh
set -eu
trap 'exit 143' TERM INT
printf '%s\\n' "$*" >> "$HV_DOCKER_LOG"
case "$*" in
  *pg_dump*) printf '%s\\n' 'SELECT current_database();' ;;
  *psql*)
    cat > "$HV_PSQL_INPUT"
    if [ "\${HV_FAIL_RESTORE:-0}" = 1 ]; then exit 7; fi
    if [ "\${HV_BLOCK_RESTORE:-0}" = 1 ]; then while :; do sleep 1; done; fi
    ;;
esac
`;

export const TEST_KEY = 'backup-test-key-012345678901234567890123456789';
export type RunResult = Readonly<{ stdout: string; stderr: string; status: number }>;
type FailedProcess = Error & {
  code?: number | string;
  stdout?: string;
  stderr?: string;
  status?: number;
};

function isFailedProcess(error: unknown): error is FailedProcess {
  return error instanceof Error && ('status' in error || 'code' in error);
}

export async function createHarness(
  database: Readonly<{ getUsername(): string; getDatabase(): string; getPassword(): string }>,
  key?: string,
): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'heartbeat-backup-test-'));
  const bin = join(root, 'bin');
  const cryptoBin = join(root, 'crypto-bin');
  await mkdir(bin);
  await mkdir(cryptoBin);
  await writeFile(join(root, 'install.sh'), await readFile(installScript));
  await chmod(join(root, 'install.sh'), 0o700);
  await writeFile(
    join(root, '.env'),
    `POSTGRES_USER=${database.getUsername()}\nPOSTGRES_DB=${database.getDatabase()}\n${
      key === undefined ? '' : `BACKUP_ENCRYPTION_KEY=${key}\n`
    }RESTORE_TARGET_USER=${database.getUsername()}\nRESTORE_TARGET_DB=${database.getDatabase()}\nRESTORE_TARGET_PASSWORD=${database.getPassword()}\n`,
  );
  await writeFile(join(bin, 'docker'), fakeDockerScript);
  await chmod(join(bin, 'docker'), 0o700);
  await writeFile(
    join(cryptoBin, 'openssl'),
    '#!/bin/sh\ncase "${HV_DELAY_DECRYPTION:-0}:$*" in 1:*" -d "*) sleep 2;; esac\nexec /usr/bin/openssl "$@"\n',
  );
  await chmod(join(cryptoBin, 'openssl'), 0o700);
  return root;
}

export async function runInstaller(
  root: string,
  args: readonly string[],
  extraEnv: Readonly<Record<string, string>> = {},
): Promise<RunResult> {
  try {
    const result = await execFileAsync(join(root, 'install.sh'), [...args], {
      cwd: root,
      env: {
        ...process.env,
        PATH:
          extraEnv['HV_USE_REAL_DOCKER'] === '1'
            ? process.env['PATH']
            : `${join(root, 'bin')}:${process.env['PATH']}`,
        ...extraEnv,
      },
    });
    return { stdout: result.stdout, stderr: result.stderr, status: 0 };
  } catch (error) {
    if (!isFailedProcess(error)) throw error;
    const code = typeof error.status === 'number' ? error.status : error.code;
    return {
      stdout: error.stdout ?? '',
      stderr: error.stderr ?? '',
      status: typeof code === 'number' ? code : 1,
    };
  }
}

export async function makePlainBackup(
  root: string,
  sql = 'SELECT current_database();',
): Promise<string> {
  const backup = join(root, 'input.sql.gz');
  await execFileAsync('sh', ['-c', `printf '%s\n' "$2" | gzip > "$1"`, '--', backup, sql]);
  return backup;
}

export async function encryptBackup(plain: string): Promise<string> {
  const encrypted = `${plain}.enc`;
  await execFileAsync(
    'openssl',
    [
      'enc',
      '-aes-256-cbc',
      '-pbkdf2',
      '-salt',
      '-in',
      plain,
      '-out',
      encrypted,
      '-pass',
      'env:BACKUP_KEY_ENV',
    ],
    { env: { ...process.env, BACKUP_KEY_ENV: TEST_KEY } },
  );
  await rm(plain, { force: true });
  return encrypted;
}

export async function cleanupHarness(root: string): Promise<void> {
  await rm(root, { recursive: true, force: true });
}
