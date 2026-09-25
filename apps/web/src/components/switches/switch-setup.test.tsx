import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SwitchSetup } from './switch-setup';

const switchId = '9bc2f8e0-9b2f-4d14-ae5f-d8c7a0956d3f';

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
}

describe('SwitchSetup', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('renders per-channel and payload guidance disclosures', () => {
    render(<SwitchSetup switchId={switchId} disabled={false} />);

    expect(screen.getByRole('button', { name: 'What is email delivery?' })).toHaveAttribute(
      'aria-expanded',
      'false',
    );
    expect(screen.getByRole('button', { name: 'What is webhook delivery?' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'What is telegram delivery?' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'What is the release payload?' })).toBeVisible();

    fireEvent.click(screen.getByRole('button', { name: 'What is email delivery?' }));
    expect(screen.getByRole('region', { name: 'email delivery explanation' })).toHaveTextContent(
      'at-least-once',
    );
    const emailHint = (_: unknown, element: unknown): boolean =>
      (element as HTMLElement | null)?.textContent === 'Example: recipient@example.com';
    expect(screen.getAllByText(emailHint)).toHaveLength(2);

    fireEvent.click(screen.getByRole('radio', { name: 'Telegram' }));
    const telegramHint = (_: unknown, element: unknown): boolean =>
      (element as HTMLElement | null)?.textContent === 'Example: -1001234567890';
    expect(screen.getAllByText(telegramHint)).toHaveLength(2);
    expect(screen.getAllByText(emailHint)).toHaveLength(1);
  });
  it('keeps recipient invitations on the existing POST contract', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(jsonResponse({ id: switchId, inviteToken: 'ephemeral-token' }));
    render(<SwitchSetup switchId={switchId} disabled={false} />);

    fireEvent.change(screen.getByLabelText('Address'), {
      target: { value: 'recipient@example.com' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Create invitation' }));

    expect(await screen.findByText(/Recipient invited/)).toBeVisible();
    expect(fetchMock).toHaveBeenCalledWith(
      `/api/switches/${switchId}/recipients`,
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ channel: 'email', address: 'recipient@example.com' }),
        credentials: 'include',
      }),
    );
  });

  it('keeps payload sealing on the existing POST contract', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(jsonResponse({ storedBytes: 15 }));
    render(<SwitchSetup switchId={switchId} disabled={false} />);

    fireEvent.change(screen.getByLabelText('Release payload'), {
      target: { value: 'sealed material' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Seal and store payload' }));

    expect(await screen.findByText('Payload sealed and stored (15 bytes).')).toBeVisible();
    expect(fetchMock).toHaveBeenCalledWith(
      `/api/switches/${switchId}/payload`,
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ plaintext: 'sealed material' }),
        credentials: 'include',
      }),
    );
  });
});
