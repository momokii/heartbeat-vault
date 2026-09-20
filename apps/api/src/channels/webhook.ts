import { createHmac } from 'node:crypto';
import ky, { isHTTPError } from 'ky';
import type { DeliveryChannel, DeliveryContext, DeliveryResult } from './types.js';

export type WebhookChannelConfig = {
  readonly signingSecret: string;
  readonly timeoutMs?: number;
};

export function createWebhookChannel(config: WebhookChannelConfig): DeliveryChannel {
  return {
    async send(context: DeliveryContext): Promise<DeliveryResult> {
      const body = JSON.stringify({
        kind: context.payload.kind,
        switchId: context.payload.switchId,
        recipientId: context.payload.recipientId,
        dryRun: context.payload.dryRun ?? false,
      });
      try {
        const response = await ky.post(context.address, {
          body,
          headers: {
            'content-type': 'application/json',
            'idempotency-key': context.idempotencyKey,
            'x-heartbeat-signature': webhookSignature(body, config.signingSecret),
          },
          retry: 0,
          timeout: config.timeoutMs ?? 10_000,
        });
        return {
          status: 'sent',
          receipt: response.headers.get('x-request-id') ?? `webhook:${response.status}`,
        };
      } catch (error) {
        return httpFailure(error, 'webhook');
      }
    },
  };
}

export function webhookSignature(body: string, signingSecret: string): string {
  return `sha256=${createHmac('sha256', signingSecret).update(body).digest('hex')}`;
}

function httpFailure(error: unknown, provider: string): DeliveryResult {
  if (isHTTPError(error)) {
    const { status } = error.response;
    if (status >= 400 && status < 500 && status !== 408 && status !== 429) {
      return { status: 'dead', error: `${provider} rejected request with HTTP ${status}` };
    }
    return { status: 'retry', error: `${provider} returned HTTP ${status}` };
  }
  return {
    status: 'retry',
    error: error instanceof Error ? error.message : `${provider} request failed`,
  };
}
