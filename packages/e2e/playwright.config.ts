import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './src',
  testIgnore: 'caddy.smoke.spec.ts',
  globalSetup: './src/global-setup.ts',
  fullyParallel: false,
  workers: 1,
  use: { baseURL: 'http://localhost:5174' },
});
