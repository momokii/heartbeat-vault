import { z } from 'zod';
import { createEmailChannel } from './email.js';
import { createTelegramChannel } from './telegram.js';
import { createWebhookChannel } from './webhook.js';
import { createChannelRegistry } from './types.js';
import type { ChannelRegistry, DeliveryChannel } from './types.js';

const ChannelEnvironment = z
  .object({
    SMTP_HOST: z.string().min(1).optional(),
    SMTP_PORT: z.coerce.number().int().min(1).max(65_535).optional(),
    SMTP_FROM: z.string().email().optional(),
    SMTP_USER: z.string().min(1).optional(),
    SMTP_PASS: z.string().min(1).optional(),
    WEBHOOK_HMAC_SECRET: z.string().min(32).optional(),
    TELEGRAM_BOT_TOKEN: z.string().min(1).optional(),
    TELEGRAM_API_BASE_URL: z.string().url().optional(),
  })
  .superRefine((environment, context) => {
    const smtpValues = [environment.SMTP_HOST, environment.SMTP_PORT, environment.SMTP_FROM];
    if (
      smtpValues.some(value => value !== undefined) &&
      smtpValues.some(value => value === undefined)
    ) {
      context.addIssue({
        code: 'custom',
        message: 'SMTP_HOST, SMTP_PORT, and SMTP_FROM must be configured together',
      });
    }
    if ((environment.SMTP_USER === undefined) !== (environment.SMTP_PASS === undefined)) {
      context.addIssue({
        code: 'custom',
        message: 'SMTP_USER and SMTP_PASS must be configured together',
      });
    }
  });

export function createConfiguredChannelRegistry(
  environment: Record<string, string | undefined>,
): ChannelRegistry {
  const config = ChannelEnvironment.parse(environment);
  const channels: Record<string, DeliveryChannel> = {};

  if (
    config.SMTP_HOST !== undefined &&
    config.SMTP_PORT !== undefined &&
    config.SMTP_FROM !== undefined
  ) {
    channels.email =
      config.SMTP_USER !== undefined && config.SMTP_PASS !== undefined
        ? createEmailChannel({
            from: config.SMTP_FROM,
            host: config.SMTP_HOST,
            port: config.SMTP_PORT,
            secure: config.SMTP_PORT === 465,
            auth: { user: config.SMTP_USER, pass: config.SMTP_PASS },
          })
        : createEmailChannel({
            from: config.SMTP_FROM,
            host: config.SMTP_HOST,
            port: config.SMTP_PORT,
            secure: config.SMTP_PORT === 465,
          });
  }
  if (config.WEBHOOK_HMAC_SECRET !== undefined) {
    channels.webhook = createWebhookChannel({ signingSecret: config.WEBHOOK_HMAC_SECRET });
  }
  if (config.TELEGRAM_BOT_TOKEN !== undefined) {
    channels.telegram = createTelegramChannel({
      apiBaseUrl: config.TELEGRAM_API_BASE_URL ?? 'https://api.telegram.org',
      botToken: config.TELEGRAM_BOT_TOKEN,
    });
  }
  return createChannelRegistry(channels);
}
