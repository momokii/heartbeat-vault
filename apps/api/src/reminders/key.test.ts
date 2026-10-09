import { describe, expect, it } from 'vitest';

const reminderModulePath = './index.js';

async function loadReminderModule() {
  return import(reminderModulePath);
}

const SWITCH_ID = '11111111-1111-4111-8111-111111111111';
const DEADLINE = '2026-10-01T00:00:00.000Z';

describe('owner reminder key', () => {
  it('includes switch, deadline, stage, and channel in a stable key', async () => {
    const input = {
      switchId: SWITCH_ID,
      deadlineAt: DEADLINE,
      stage: 'reminder' as const,
      channel: 'email' as const,
    };

    const { buildReminderKey } = await loadReminderModule();
    const first = buildReminderKey(input);
    const second = buildReminderKey({ ...input });

    expect(first).toBe(`reminder:${SWITCH_ID}:${DEADLINE}:reminder:email`);
    expect(second).toBe(first);
  });
});

describe('owner reminder input validation', () => {
  it('rejects a missing owner email', async () => {
    const { ownerReminderInputSchema } = await loadReminderModule();
    const result = ownerReminderInputSchema.safeParse({
      switchId: SWITCH_ID,
      deadlineAt: DEADLINE,
      stage: 'reminder',
      channel: 'email',
    });

    expect(result.success).toBe(false);
  });

  it.each([
    ['deadlineAt', 'not-a-deadline'],
    ['stage', 'pending'],
    ['channel', 'telegram'],
  ] as const)('rejects malformed %s', async (field, value) => {
    const { ownerReminderInputSchema } = await loadReminderModule();
    const result = ownerReminderInputSchema.safeParse({
      switchId: SWITCH_ID,
      ownerEmail: 'owner@example.test',
      deadlineAt: field === 'deadlineAt' ? value : DEADLINE,
      stage: field === 'stage' ? value : 'reminder',
      channel: field === 'channel' ? value : 'email',
    });

    expect(result.success).toBe(false);
  });
});
