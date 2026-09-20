import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './src',
  testMatch: 'caddy.smoke.spec.ts',
  fullyParallel: false,
  workers: 1,
  use: { baseURL: process.env.CADDY_BASE_URL ?? 'http://127.0.0.1:18080' },
});
