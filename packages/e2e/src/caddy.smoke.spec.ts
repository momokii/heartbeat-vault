import { expect, test } from '@playwright/test';

test('serves the SPA at the root through Caddy', async ({ page }) => {
  const response = await page.goto('/');

  expect(response?.status()).toBe(200);
  await expect(page.getByText('Standard profile · v0.0.0')).toBeVisible();
});

test('serves the login SPA route directly through Caddy', async ({ page }) => {
  const response = await page.goto('/login');

  expect(response?.status()).toBe(200);
  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
});

test('proxies API health through Caddy', async ({ request }) => {
  const response = await request.get('/api/health');

  expect(response.status()).toBe(200);
});
