import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TriggerConfiguration } from './trigger-configuration';

const switchId = '9bc2f8e0-9b2f-4d14-ae5f-d8c7a0956d3f';

function jsonResponse(triggerType: 'fixed_date' | 'quorum' | 'panic'): Response {
  return new Response(JSON.stringify({ ok: true, triggerType }), {
    headers: { 'content-type': 'application/json' },
  });
}

describe('TriggerConfiguration', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('renders a disclosure and short explanation for every trigger choice', () => {
    render(<TriggerConfiguration switchId={switchId} disabled={false} />);

    const fixedDateHelp = screen.getByRole('button', { name: 'What is the fixed-date trigger?' });
    expect(screen.getByRole('button', { name: 'What is the quorum trigger?' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'What is the panic trigger?' })).toBeVisible();

    fireEvent.click(fixedDateHelp);
    expect(
      screen.getByRole('region', { name: 'the fixed-date trigger explanation' }),
    ).toHaveTextContent('must be in the future');
  });

  it('keeps fixed-date trigger serialization unchanged', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse('fixed_date'));
    render(<TriggerConfiguration switchId={switchId} disabled={false} />);
    const value = '2030-01-02T03:04';

    fireEvent.change(screen.getByLabelText('Fire at'), { target: { value } });
    fireEvent.click(screen.getByRole('button', { name: 'Save trigger' }));

    expect(await screen.findByText('Fixed-date trigger configured.')).toBeVisible();
    expect(fetchMock).toHaveBeenCalledWith(
      `/api/switches/${switchId}/trigger`,
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ type: 'fixed_date', fireAt: new Date(value).toISOString() }),
        credentials: 'include',
      }),
    );
  });

  it('keeps quorum and acknowledged panic trigger serialization unchanged', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(jsonResponse('quorum'))
      .mockResolvedValueOnce(jsonResponse('panic'));
    render(<TriggerConfiguration switchId={switchId} disabled={false} />);

    fireEvent.click(screen.getByRole('radio', { name: 'Recipient quorum' }));
    fireEvent.change(screen.getByLabelText('Required recipient votes'), { target: { value: '3' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save trigger' }));
    expect(await screen.findByText('Quorum trigger configured.')).toBeVisible();

    fireEvent.click(screen.getByRole('radio', { name: 'Panic trigger' }));
    fireEvent.click(screen.getByLabelText(/I understand this begins the release workflow/i));
    fireEvent.click(screen.getByRole('button', { name: 'Trigger panic release' }));
    expect(await screen.findByText(/Panic trigger configured/)).toBeVisible();

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      `/api/switches/${switchId}/trigger`,
      expect.objectContaining({ body: JSON.stringify({ type: 'quorum', threshold: 3 }) }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      `/api/switches/${switchId}/trigger`,
      expect.objectContaining({ body: JSON.stringify({ type: 'panic', confirm: true }) }),
    );
  });
});
