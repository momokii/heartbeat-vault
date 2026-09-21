import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    exclude: ['dist', 'node_modules'],
    testTimeout: 120000,
    hookTimeout: 120000,
    pool: 'forks',
    poolOptions: {
      forks: { singleFork: true },
    },
    coverage: {
      provider: 'v8',
      include: [
        'src/routes/auth.ts',
        'src/routes/account.ts',
        'src/routes/two-factor.ts',
        'src/lib/auth-middleware.ts',
        'src/lib/totp-store.ts',
        'src/lib/trigger-engine.ts',
        'src/lib/downtime.ts',
        'src/lib/escalation.ts',
        'src/channels/**',
      ],
      thresholds: {
        lines: 84,
        functions: 88,
        branches: 65,
        statements: 84,
      },
      reporter: ['text'],
      all: true,
    },
  },
});
