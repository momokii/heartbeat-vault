import ky, { isHTTPError } from 'ky';
import { z } from 'zod';
import type { DeliveryChannel, DeliveryContext, DeliveryResult } from './types.js';

const TelegramResponse = z.object({
  ok: z.boolean(),
  result: z.object({ message_id: z.number().int() }).optional(),
  description: z.string().optional(),
});

export type TelegramChannelConfig = {
  readonly apiBaseUrl: string;
  readonly botToken: string;
  readonly timeoutMs?: number;
};

export function createTelegramChannel(config: TelegramChannelConfig): DeliveryChannel {
  const endpoint = telegramEndpoint(config);
  return {
    async send(context: DeliveryContext): Promise<DeliveryResult> {
      try {
        const response = TelegramResponse.safeParse(
          await ky
            .post(endpoint, {
              json: {
                chat_id: context.address,
                text: telegramText(context),
              },
              retry: 0,
              timeout: config.timeoutMs ?? 10_000,
            })
            .json(),
        );
        if (!response.success)
          return { status: 'retry', error: 'Telegram returned an invalid response' };
        if (!response.data.ok) {
          return {
            status: 'retry',
            error: response.data.description ?? 'Telegram rejected the request',
          };
        }
        const messageId = response.data.result?.message_id;
        if (messageId === undefined)
          return { status: 'retry', error: 'Telegram omitted message_id' };
        return { status: 'sent', receipt: `telegram:${messageId}` };
      } catch (error) {
        return telegramFailure(error);
      }
    },
  };
}

function telegramEndpoint(config: TelegramChannelConfig): string {
  const endpoint = new URL(config.apiBaseUrl);
  endpoint.pathname = `${endpoint.pathname.replace(/\/$/, '')}/bot${config.botToken}/sendMessage`;
  return endpoint.toString();
}

function telegramText(context: DeliveryContext): string {
  const prefix = context.payload.dryRun ? '[DRY RUN] ' : '';
  return `${prefix}A Heartbeat Vault release is ready.\nReference: ${context.idempotencyKey}\nThis notification contains no release material.`;
}

function telegramFailure(error: unknown): DeliveryResult {
  if (isHTTPError(error)) {
    const { status } = error.response;
    if (status >= 400 && status < 500 && status !== 408 && status !== 429) {
      return { status: 'dead', error: `Telegram rejected request with HTTP ${status}` };
    }
    return { status: 'retry', error: `Telegram returned HTTP ${status}` };
  }
  return {
    status: 'retry',
    error: error instanceof Error ? error.message : 'Telegram request failed',
  };
}
