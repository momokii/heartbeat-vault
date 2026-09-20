import { createHash } from 'node:crypto';
import nodemailer from 'nodemailer';
import type { DeliveryChannel, DeliveryContext, DeliveryResult } from './types.js';

export type EmailChannelConfig = {
  readonly from: string;
  readonly host: string;
  readonly port: number;
  readonly secure: boolean;
  readonly auth?: {
    readonly user: string;
    readonly pass: string;
  };
};

export function emailMessageId(idempotencyKey: string): string {
  const digest = createHash('sha256').update(idempotencyKey).digest('hex');
  return `<${digest}@heartbeat-vault.local>`;
}

export function createEmailChannel(config: EmailChannelConfig): DeliveryChannel {
  const transport = config.auth
    ? nodemailer.createTransport({
        host: config.host,
        port: config.port,
        secure: config.secure,
        auth: config.auth,
      })
    : nodemailer.createTransport({
        host: config.host,
        port: config.port,
        secure: config.secure,
      });

  return {
    async send(context: DeliveryContext): Promise<DeliveryResult> {
      try {
        const info = await transport.sendMail({
          from: config.from,
          to: context.address,
          subject: emailSubject(context),
          text: emailText(context),
          messageId: emailMessageId(context.idempotencyKey),
        });
        if (info.rejected.length > 0) {
          return { status: 'dead', error: `SMTP rejected ${info.rejected.join(', ')}` };
        }
        if (!info.accepted.includes(context.address)) {
          return { status: 'retry', error: 'SMTP accepted no requested recipient' };
        }
        return { status: 'sent', receipt: info.messageId };
      } catch (error) {
        return { status: 'retry', error: messageFrom(error) };
      }
    },
  };
}

function emailSubject(context: DeliveryContext): string {
  const prefix = context.payload.dryRun ? '[DRY RUN] ' : '';
  return `${prefix}Heartbeat Vault release ready`;
}

function emailText(context: DeliveryContext): string {
  const prefix = context.payload.dryRun ? '[DRY RUN] ' : '';
  return `${prefix}A Heartbeat Vault release is ready.\n\nSwitch: ${context.payload.switchId}\nNotification: ${context.payload.kind}\n\nThis notification contains no release material.`;
}

function messageFrom(error: unknown): string {
  return error instanceof Error ? error.message : 'SMTP transport failed';
}
