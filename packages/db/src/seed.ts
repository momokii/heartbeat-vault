import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';

export interface SeedOptions {
  readonly connectionString?: string;
}

const DEFAULT_CONFIG: ReadonlyArray<{ key: string; value: string }> = [
  { key: 'setup_completed', value: 'false' },
  { key: 'setup_token_hash', value: '' },
];

export async function seed(options: SeedOptions = {}): Promise<void> {
  const connectionString = options.connectionString ?? process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error('DATABASE_URL is required for seeding');
  }

  const pool = new Pool({ connectionString });
  try {
    const db = drizzle(pool);

    for (const entry of DEFAULT_CONFIG) {
      await db.execute(sql`
        INSERT INTO app_config (key, value, updated_at)
        VALUES (${entry.key}, ${entry.value}, clock_timestamp())
        ON CONFLICT (key) DO NOTHING
      `);
    }
  } finally {
    await pool.end();
  }
}

const isMain = process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`;

if (isMain) {
  seed()
    .then(() => {
      // eslint-disable-next-line no-console
      console.log('Seed completed');
      process.exit(0);
    })
    .catch((err: unknown) => {
      // eslint-disable-next-line no-console
      console.error('Seed failed:', err);
      process.exit(1);
    });
}
