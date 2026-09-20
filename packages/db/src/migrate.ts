import { join, dirname } from 'node:path';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const { Pool } = pg;

const __dirname = dirname(fileURLToPath(import.meta.url));

export interface MigrateOptions {
  readonly connectionString?: string;
  readonly migrationsFolder?: string;
}

function getMigrationsFolder(override?: string): string {
  if (override) return override;
  // When running from src (tsx) vs dist, resolve accordingly
  return join(__dirname, '..', 'drizzle');
}

export async function migrate(options: MigrateOptions = {}): Promise<void> {
  const connectionString = options.connectionString ?? process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error('DATABASE_URL is required for migration');
  }

  const migrationsFolder = getMigrationsFolder(options.migrationsFolder);
  const pool = new Pool({ connectionString });

  try {
    // drizzle-orm migrator will handle journal + SQL files
    const { drizzle } = await import('drizzle-orm/node-postgres');
    const { migrate: drizzleMigrate } = await import('drizzle-orm/node-postgres/migrator');

    const db = drizzle(pool);
    await drizzleMigrate(db, { migrationsFolder });
  } finally {
    await pool.end();
  }
}

// CLI entry: `tsx src/migrate.ts` or `pnpm db:migrate`
// Realpath comparison: pnpm installs workspace deps as symlinks, so argv[1]
// (symlinked path) and import.meta.url (real path) differ by string but not by
// identity — naive equality silently skips this CLI entry inside containers.
const isMain =
  process.argv[1] !== undefined &&
  realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]);

if (isMain) {
  migrate()
    .then(() => {
      // eslint-disable-next-line no-console
      console.log('Migrations applied successfully');
      process.exit(0);
    })
    .catch((err: unknown) => {
      // eslint-disable-next-line no-console
      console.error('Migration failed:', err);
      process.exit(1);
    });
}
