import { createHmac } from 'node:crypto';
import { createServer } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { createTelegramChannel } from './channels/telegram.js';
import { createWebhookChannel } from './channels/webhook.js';
import type { DeliveryContext } from './channels/types.js';

type CapturedRequest = {
  readonly path: string;
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
  readonly body: string;
};

type MockServer = {
  readonly url: string;
  readonly requests: CapturedRequest[];
  close(): Promise<void>;
};

const servers: MockServer[] = [];

function deliveryContext(address = '12345'): DeliveryContext {
  return {
    channel: 'webhook',
    idempotencyKey: 'delivery:test-1',
    address,
    payload: {
      kind: 'release',
      switchId: 'switch-1',
      recipientId: 'recipient-1',
    },
  };
}

async function createMockServer(status: number, response: object): Promise<MockServer> {
  const requests: CapturedRequest[] = [];
  const server = createServer((request, responseWriter) => {
    const chunks: Uint8Array[] = [];
    request.on('data', (chunk: Uint8Array) => chunks.push(chunk));
    request.on('end', () => {
      requests.push({
        path: request.url ?? '',
        headers: request.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      });
      responseWriter.writeHead(status, {
        'content-type': 'application/json',
        'x-request-id': 'request-1',
      });
      responseWriter.end(JSON.stringify(response));
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('mock server did not expose a TCP address');
  return {
    url: `http://127.0.0.1:${address.port}`,
    requests,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close(error => (error ? reject(error) : resolve())),
      ),
  };
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => server.close()));
});

describe('webhook channel', () => {
  it('posts an HMAC-signed, idempotent release notification', async () => {
    const server = await createMockServer(202, {});
    servers.push(server);
    const secret = 'webhook-test-secret';
    const context = deliveryContext(`${server.url}/release`);
    const channel = createWebhookChannel({ signingSecret: secret });

    const result = await channel.send(context);

    expect(result).toEqual({ status: 'sent', receipt: 'request-1' });
    expect(server.requests).toHaveLength(1);
    const request = server.requests[0];
    expect(request?.headers['idempotency-key']).toBe(context.idempotencyKey);
    expect(request?.headers['x-heartbeat-signature']).toBe(
      `sha256=${createHmac('sha256', secret)
        .update(request?.body ?? '')
        .digest('hex')}`,
    );
    expect(request?.body).toBe(
      JSON.stringify({
        kind: 'release',
        switchId: 'switch-1',
        recipientId: 'recipient-1',
        dryRun: false,
      }),
    );
  });
});

describe('telegram channel', () => {
  it('posts a notification with the durable idempotency reference to the Bot API', async () => {
    const server = await createMockServer(200, { ok: true, result: { message_id: 42 } });
    servers.push(server);
    const context = deliveryContext();
    const channel = createTelegramChannel({ apiBaseUrl: server.url, botToken: 'bot-token' });

    const result = await channel.send(context);

    expect(result).toEqual({ status: 'sent', receipt: 'telegram:42' });
    expect(server.requests).toHaveLength(1);
    const request = server.requests[0];
    expect(request?.path).toBe('/botbot-token/sendMessage');
    expect(request?.body).toContain('"chat_id":"12345"');
    expect(request?.body).toContain('Reference: delivery:test-1');
    expect(request?.body).not.toContain('secret');
  });
});
