import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { HeartbeatCheckin } from './heartbeat-checkin';

const switchId = '9bc2f8e0-9b2f-4d14-ae5f-d8c7a0956d3f';

describe('HeartbeatCheckin', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('explains check-in, optional TOTP, and the deadline result', () => {
    render(<HeartbeatCheckin switchId={switchId} active />);

    const help = screen.getByRole('button', { name: 'What is checking in?' });
    fireEvent.click(help);

    expect(help).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('region', { name: 'checking in explanation' })).toHaveTextContent(
      'now plus its interval',
    );
    expect(screen.getByRole('button', { name: 'What is an authenticator code?' })).toBeVisible();
  });

  it('keeps the optional TOTP check-in POST body unchanged', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), {
        headers: { 'content-type': 'application/json' },
      }),
    );
    render(<HeartbeatCheckin switchId={switchId} active />);

    fireEvent.change(screen.getByLabelText('Authenticator code (if enabled)'), {
      target: { value: '123456' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Check in now' }));

    expect(await screen.findByText(/Check-in recorded/)).toBeVisible();
    expect(fetchMock).toHaveBeenCalledWith(
      `/api/switches/${switchId}/check-in`,
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ totpCode: '123456' }),
        credentials: 'include',
      }),
    );
  });
});
