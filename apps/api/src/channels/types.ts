// Pluggable delivery channel interface (T5.1, ADR-002 outbox consumers).
//
// Contract: a provider receives an immutable context (channel, idempotency
// key, recipient address, payload) and returns exactly one outcome:
//   {status:'sent', receipt}  — provider accepted; receipt is stored
//   {status:'retry', error}   — transient failure; dispatcher requeues with
//                               jittered backoff until max attempts
//   {status:'dead', error}    — permanent rejection; straight to DLQ
// Providers must never throw for expected failures — throwing is treated as
// a retryable fault by the dispatcher. Idempotency is enforced at two layers:
// the delivery_jobs UNIQUE key (DB) and the provider-level key (e.g. email
// Message-ID, webhook Idempotency-Key header).
export type DeliveryPayload = {
  readonly kind: string;
  readonly switchId: string;
  readonly recipientId: string;
  readonly dryRun?: boolean;
};

export type DeliveryContext = {
  readonly channel: string;
  readonly idempotencyKey: string;
  readonly address: string;
  readonly payload: DeliveryPayload;
};

export type DeliveryResult =
  | { readonly status: 'sent'; readonly receipt: string }
  | { readonly status: 'retry'; readonly error: string }
  | { readonly status: 'dead'; readonly error: string };

export interface DeliveryChannel {
  send(ctx: DeliveryContext): Promise<DeliveryResult>;
}

export type ChannelRegistry = {
  get(channel: string): DeliveryChannel | undefined;
  readonly names: readonly string[];
};

export function createChannelRegistry(channels: Record<string, DeliveryChannel>): ChannelRegistry {
  const map = new Map(Object.entries(channels));
  return {
    get: (channel: string) => map.get(channel),
    names: Object.freeze([...map.keys()]),
  };
}
