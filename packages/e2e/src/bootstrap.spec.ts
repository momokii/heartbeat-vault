import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import pg from 'pg';

const { Pool } = pg;

test('bootstrap creates, configures, arms, releases, and delivers a switch', async ({ page }) => {
  await page.goto('/setup');
  await page.getByLabel('Setup token').fill('e2e-bootstrap-token-1234567890');
  await page.getByLabel('Administrator email').fill('admin@example.test');
  await page.getByLabel('Password', { exact: true }).fill('correct-horse-battery-staple');
  await page.getByLabel('Confirm password').fill('correct-horse-battery-staple');
  await page.getByRole('button', { name: 'Create administrator' }).click();
  await expect(page.getByText('Your vault is ready.')).toBeVisible();
  await Promise.all([
    page.waitForURL('**/login'),
    page.getByRole('button', { name: 'Continue to sign in' }).click(),
  ]);
  await page.getByLabel('Email').fill('admin@example.test');
  await page.getByLabel('Password').fill('correct-horse-battery-staple');
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByRole('heading', { name: 'Your switches' })).toBeVisible();

  await page.getByRole('link', { name: 'Create switch' }).click();
  await page.getByLabel('Name').fill('Emergency release plan');
  await Promise.all([
    page.waitForURL('**/'),
    page.getByRole('button', { name: 'Create paused switch' }).click(),
  ]);
  await expect(page.getByRole('heading', { name: 'Emergency release plan' })).toBeVisible();
  await expect(page.getByText('Paused', { exact: true })).toBeVisible();

  await page.getByRole('link', { name: 'Manage switch' }).click();
  await page.getByLabel('Address').fill('recipient@example.test');
  const recipientResponse = page.waitForResponse(
    response =>
      /\/api\/switches\/[^/]+\/recipients$/.test(response.url()) &&
      response.request().method() === 'POST',
  );
  await page.getByRole('button', { name: 'Create invitation' }).click();
  const recipientResult = await recipientResponse;
  expect(recipientResult.status(), await recipientResult.text()).toBe(201);
  const invitation = page.getByRole('alert');
  await expect(invitation).toContainText('Invitation token');
  const invitationText = await invitation.textContent();
  const token = invitationText?.match(/: ([A-Za-z0-9_-]+)$/)?.[1];
  expect(token).toBeDefined();

  await page
    .getByLabel('Release payload')
    .fill('Release instructions for the designated recipient.');
  const payloadResponse = page.waitForResponse(
    response =>
      /\/api\/switches\/[^/]+\/payload$/.test(response.url()) &&
      response.request().method() === 'POST',
  );
  await page.getByRole('button', { name: 'Seal and store payload' }).click();
  const payloadResult = await payloadResponse;
  expect(payloadResult.status(), await payloadResult.text()).toBe(201);
  await expect(page.getByText(/Payload sealed and stored/)).toBeVisible();

  const acceptance = await page.request.post('/api/recipients/accept', { data: { token } });
  expect(acceptance.ok()).toBeTruthy();

  await page.getByRole('button', { name: 'Arm switch' }).click();
  await expect(page.getByText(/Switch armed\./)).toBeVisible();
  await expect(page.getByText('Key release · active')).toBeVisible();

  const checkInResponse = page.waitForResponse(
    response =>
      /\/api\/switches\/[^/]+\/check-in$/.test(response.url()) &&
      response.request().method() === 'POST',
  );
  await page.getByRole('button', { name: 'Check in now' }).click();
  const checkInResult = await checkInResponse;
  expect(checkInResult.status(), await checkInResult.text()).toBe(200);
  await expect(page.getByText(/Check-in recorded\./)).toBeVisible();

  await page.getByRole('link', { name: '← Dashboard' }).click();
  await expect(page.getByRole('heading', { name: 'Your switches' })).toBeVisible();
  await expect(page.getByText('Active', { exact: true })).toBeVisible();
  await expect(page.getByText(/Next check-in:/)).toBeVisible();

  await page.getByRole('link', { name: 'Manage switch' }).click();
  const triggerResponse = page.waitForResponse(
    response =>
      /\/api\/switches\/[^/]+\/trigger$/.test(response.url()) &&
      response.request().method() === 'POST',
  );
  await page.getByRole('radio', { name: 'Panic trigger' }).check();
  await page
    .getByRole('checkbox', { name: /I understand this begins the release workflow/ })
    .check();
  await page.getByRole('button', { name: 'Trigger panic release' }).click();
  const triggerResult = await triggerResponse;
  expect(triggerResult.status(), await triggerResult.text()).toBe(200);
  await expect(page.getByText(/Panic trigger configured\./)).toBeVisible();

  await expect(async () => {
    await page.reload();
    await expect(page.getByText('Key release · released')).toBeVisible();
  }).toPass({ timeout: 20_000 });

  await page.getByRole('link', { name: '← Dashboard' }).click();
  await expect(page.getByText('Released', { exact: true })).toBeVisible();

  const runtime = JSON.parse(
    readFileSync(new URL('../test-results/e2e-runtime.json', import.meta.url), 'utf8'),
  ) as { databaseUrl: string; mailpitApiUrl: string };
  const pool = new Pool({ connectionString: runtime.databaseUrl });
  try {
    const released = await pool.query<{ id: string }>(
      `SELECT id FROM switches WHERE status='released' LIMIT 1`,
    );
    const switchId = released.rows[0]!.id;
    const recipient = await pool.query<{ id: string }>(
      `SELECT id FROM recipients WHERE switch_id=$1 AND status='accepted' LIMIT 1`,
      [switchId],
    );
    const releaseJob = await pool.query<{ id: number }>(
      `SELECT id FROM trigger_jobs WHERE switch_id=$1 ORDER BY id DESC LIMIT 1`,
      [switchId],
    );
    const idempotencyKey = `e2e:due:${randomUUID()}`;
    await pool.query(
      `INSERT INTO delivery_jobs (switch_id, trigger_job_id, channel, state, available_at, idempotency_key, payload)
       VALUES ($1, $2, 'email', 'pending', clock_timestamp(), $3, $4)`,
      [
        switchId,
        releaseJob.rows[0]!.id,
        idempotencyKey,
        JSON.stringify({ kind: 'release', switchId, recipientId: recipient.rows[0]!.id }),
      ],
    );

    await expect(async () => {
      const job = await pool.query<{ state: string; last_error: string | null }>(
        `SELECT state, last_error FROM delivery_jobs WHERE idempotency_key=$1`,
        [idempotencyKey],
      );
      expect(job.rows[0]?.state, job.rows[0]?.last_error ?? undefined).toBe('succeeded');
    }).toPass({ timeout: 15_000, intervals: [500] });

    const expectedMessageId = `<${createHash('sha256').update(idempotencyKey).digest('hex')}@heartbeat-vault.local>`;
    const inbox = (await fetch(`${runtime.mailpitApiUrl}/api/v1/messages`).then(response =>
      response.json(),
    )) as { messages: Array<{ ID: string; To: Array<{ Address: string }>; Subject: string }> };
    const delivered = inbox.messages.find(
      message =>
        message.Subject === 'Heartbeat Vault release ready' &&
        message.To.some(to => to.Address === 'recipient@example.test'),
    );
    expect(delivered).toBeDefined();
    const raw = await fetch(`${runtime.mailpitApiUrl}/api/v1/message/${delivered!.ID}/raw`).then(
      response => response.text(),
    );
    const unfolded = raw.replace(/\r?\n[ \t]+/g, ' ');
    expect(unfolded).toContain(`Message-ID: ${expectedMessageId}`);
    expect(raw).toContain(`Switch: ${switchId}`);
    expect(raw).toContain('A Heartbeat Vault release is ready.');
    expect(raw).not.toContain('[DRY RUN]');
  } finally {
    await pool.end();
  }
});
