import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GenericContainer, type StartedTestContainer } from 'testcontainers';
import { createEmailChannel, emailMessageId } from './channels/email.js';
import type { DeliveryContext } from './channels/types.js';

let mailpit: StartedTestContainer;

function deliveryContext(dryRun: boolean): DeliveryContext {
  return {
    channel: 'email',
    idempotencyKey: 'delivery:test-1',
    address: 'recipient@example.test',
    payload: {
      kind: 'release',
      switchId: 'switch-1',
      recipientId: 'recipient-1',
      dryRun,
    },
  };
}

beforeAll(async () => {
  mailpit = await new GenericContainer('axllent/mailpit:v1.27.4')
    .withExposedPorts(1025, 8025)
    .start();
}, 180_000);

afterAll(async () => {
  await mailpit?.stop();
});

describe('email channel', () => {
  it('delivers a safe release notice with a stable Message-ID through Mailpit', async () => {
    const channel = createEmailChannel({
      from: 'vault@example.test',
      host: mailpit.getHost(),
      port: mailpit.getMappedPort(1025),
      secure: false,
    });

    const context = deliveryContext(false);
    const result = await channel.send(context);

    expect(result.status).toBe('sent');
    const raw = await fetch(
      `http://${mailpit.getHost()}:${mailpit.getMappedPort(8025)}/api/v1/message/latest/raw`,
    ).then(response => response.text());
    const unfoldedHeaders = raw.replace(/\r?\n[ \t]+/g, ' ');
    expect(unfoldedHeaders).toContain(`Message-ID: ${emailMessageId(context.idempotencyKey)}`);
    expect(raw).toContain('A Heartbeat Vault release is ready.');
    expect(raw).not.toContain('secret');
  });

  it('labels a dry-run notification without changing its delivery contract', async () => {
    const channel = createEmailChannel({
      from: 'vault@example.test',
      host: mailpit.getHost(),
      port: mailpit.getMappedPort(1025),
      secure: false,
    });

    const result = await channel.send(deliveryContext(true));

    expect(result.status).toBe('sent');
    const raw = await fetch(
      `http://${mailpit.getHost()}:${mailpit.getMappedPort(8025)}/api/v1/message/latest/raw`,
    ).then(response => response.text());
    expect(raw).toContain('[DRY RUN]');
  });
});
