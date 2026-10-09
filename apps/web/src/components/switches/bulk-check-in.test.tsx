import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BulkCheckIn } from './bulk-check-in';

const activeSwitches = [
  { id: '9bc2f8e0-9b2f-4d14-ae5f-d8c7a0956d3f', title: 'Family plan' },
  { id: '8b4bfa77-d7d8-4f2f-9e7e-9d0ba568175f', title: 'Business plan' },
] as const;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function renderBulkCheckIn(): void {
  render(<BulkCheckIn switches={activeSwitches} />);
}

describe('BulkCheckIn', () => {
  afterEach(() => vi.restoreAllMocks());

  it('requires confirmation before sending the bulk check-in request', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch');
    renderBulkCheckIn();

    fireEvent.click(screen.getByRole('button', { name: 'Check in all' }));

    expect(screen.getByRole('dialog')).toBeVisible();
    expect(screen.getByText('Check in all active switches?')).toBeVisible();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('shows pending state and prevents duplicate submissions', async () => {
    let resolveRequest: ((response: Response) => void) | undefined;
    const request = new Promise<Response>(resolve => {
      resolveRequest = resolve;
    });
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockReturnValue(request);
    renderBulkCheckIn();

    fireEvent.click(screen.getByRole('button', { name: 'Check in all' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm check in' }));
    fireEvent.click(screen.getByRole('button', { name: 'Checking in…' }));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/switches/check-in/all',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ switchIds: activeSwitches.map(item => item.id) }),
      }),
    );
    expect(screen.getByRole('button', { name: 'Checking in…' })).toBeDisabled();
    resolveRequest?.(jsonResponse(activeSwitches.map(item => ({ switchId: item.id, ok: true }))));
    await waitFor(() => expect(screen.getByText('All active switches checked in.')).toBeVisible());
  });

  it('renders per-switch results and clearly identifies partial failure', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse([
        { switchId: activeSwitches[0].id, ok: true },
        { switchId: activeSwitches[1].id, ok: false, error: 'not_found' },
      ]),
    );
    renderBulkCheckIn();

    fireEvent.click(screen.getByRole('button', { name: 'Check in all' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm check in' }));

    expect(await screen.findByText('Partial success: 1 of 2 switches checked in.')).toBeVisible();
    expect(screen.getByText('Family plan')).toBeVisible();
    expect(screen.getByText('Checked in')).toBeVisible();
    expect(screen.getByText('Business plan')).toBeVisible();
    expect(screen.getByText('Switch is no longer active or could not be found.')).toBeVisible();
  });

  it('surfaces TOTP and validation errors readably', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ error: 'totp_required' }, 403));
    renderBulkCheckIn();

    fireEvent.click(screen.getByRole('button', { name: 'Check in all' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm check in' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Enter a current authenticator code and try again.',
    );
  });
});
