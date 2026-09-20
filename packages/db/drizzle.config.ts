import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/schema.ts',
  out: './drizzle',
  dbCredentials: {
    url:
      process.env.DATABASE_URL ??
      'postgres://heartbeat:change-me-dev-only@localhost:5432/heartbeat_vault',
  },
  verbose: true,
  strict: true,
});
