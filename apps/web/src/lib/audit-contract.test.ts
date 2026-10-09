import { describe, expect, it } from 'vitest';
import { getAuditActionLabel, getAuditCategoryLabel, parseAuditCategory } from './audit-contract';

describe('audit contract labels', () => {
  it('labels reminder actions and categories for the activity UI', () => {
    expect(getAuditActionLabel('reminder_sent')).toBe('Reminder sent');
    expect(getAuditActionLabel('reminder_failed')).toBe('Reminder failed');
    expect(getAuditCategoryLabel('reminder')).toBe('Reminder');
    expect(parseAuditCategory('reminder')).toBe('reminder');
  });

  it('falls back to humanized raw action text for unknown actions', () => {
    expect(getAuditActionLabel('some_future_action')).toBe('some future action');
    expect(parseAuditCategory('nope')).toBe('');
  });
});
