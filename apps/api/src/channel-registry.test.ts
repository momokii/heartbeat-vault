import { describe, expect, it } from 'vitest';
import { createConfiguredChannelRegistry } from './channels/registry.js';

describe('configured channel registry', () => {
  it('enables only channels with complete configuration', () => {
    const registry = createConfiguredChannelRegistry({
      SMTP_HOST: 'mail.example.test',
      SMTP_PORT: '587',
      SMTP_FROM: 'vault@example.test',
      WEBHOOK_HMAC_SECRET: '12345678901234567890123456789012',
      TELEGRAM_BOT_TOKEN: 'telegram-token',
      TELEGRAM_API_BASE_URL: 'http://localhost:8080',
    });

    expect(registry.names).toEqual(['email', 'webhook', 'telegram']);
  });

  it('allows a deployment without configured delivery channels', () => {
    expect(createConfiguredChannelRegistry({}).names).toEqual([]);
  });

  it('rejects incomplete SMTP configuration rather than silently omitting email', () => {
    expect(() => createConfiguredChannelRegistry({ SMTP_HOST: 'mail.example.test' })).toThrow(
      'SMTP_HOST, SMTP_PORT, and SMTP_FROM must be configured together',
    );
  });
});
