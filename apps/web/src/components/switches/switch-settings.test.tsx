import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { SwitchSettings } from './switch-settings';

const item = {
  id: '9bc2f8e0-9b2f-4d14-ae5f-d8c7a0956d3f',
  title: 'Recovery plan',
  mode: 'direct_delivery',
  status: 'paused',
  heartbeatIntervalHours: 168,
  graceWindowHours: 24,
  dryRun: false,
  releasePolicy: 'fail_safe',
  heartbeatStartedAt: null,
  nextDeadline: null,
};

function renderSettings(): void {
  render(
    <MemoryRouter initialEntries={['/switches/test']}>
      <Routes>
        <Route path="/" element={<p>Dashboard</p>} />
        <Route
          path="/switches/test"
          element={<SwitchSettings item={item} onUpdated={() => undefined} />}
        />
      </Routes>
    </MemoryRouter>,
  );
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
}

describe('SwitchSettings', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('renders guidance for every setting and the permanent deletion action', () => {
    renderSettings();

    expect(screen.getByRole('button', { name: 'What is the switch name?' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'What is the heartbeat interval?' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'What is the grace window?' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'What is a dry run?' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'What is deleting this switch?' })).toBeVisible();
  });

  it('keeps settings PATCH serialization unchanged', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(item));
    renderSettings();

    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Updated plan' } });
    fireEvent.change(screen.getByLabelText('Heartbeat interval (hours)'), {
      target: { value: '48' },
    });
    fireEvent.change(screen.getByLabelText('Grace window (hours)'), { target: { value: '6' } });
    fireEvent.click(screen.getByLabelText('Test deliveries without releasing a payload'));
    fireEvent.click(screen.getByRole('button', { name: 'Save settings' }));

    expect(fetchMock).toHaveBeenCalledWith(
      `/api/switches/${item.id}`,
      expect.objectContaining({
        method: 'PATCH',
        body: JSON.stringify({
          title: 'Updated plan',
          heartbeatIntervalHours: 48,
          graceWindowHours: 6,
          dryRun: true,
        }),
        credentials: 'include',
      }),
    );
  });

  it('keeps deletion on the typed-title DELETE contract', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ ok: true }));
    renderSettings();

    fireEvent.change(screen.getByLabelText('Type “Recovery plan” to delete'), {
      target: { value: 'Recovery plan' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Delete switch' }));

    expect(
      await screen.findByRole('alertdialog', { name: 'Confirm deletion of Recovery plan' }),
    ).toBeVisible();
    expect(fetchMock).not.toHaveBeenCalledWith(
      `/api/switches/${item.id}`,
      expect.objectContaining({ method: 'DELETE' }),
    );

    fireEvent.click(screen.getByRole('button', { name: 'Yes, delete it' }));

    expect(await screen.findByText('Dashboard')).toBeVisible();
    expect(fetchMock).toHaveBeenCalledWith(
      `/api/switches/${item.id}`,
      expect.objectContaining({ method: 'DELETE', credentials: 'include' }),
    );
  });

  it('cancels the final delete confirmation without sending a request', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ ok: true }));
    renderSettings();

    fireEvent.change(screen.getByLabelText('Type “Recovery plan” to delete'), {
      target: { value: 'Recovery plan' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Delete switch' }));
    expect(
      await screen.findByRole('alertdialog', { name: 'Confirm deletion of Recovery plan' }),
    ).toBeVisible();

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(
      screen.queryByRole('alertdialog', { name: 'Confirm deletion of Recovery plan' }),
    ).not.toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalledWith(
      `/api/switches/${item.id}`,
      expect.objectContaining({ method: 'DELETE' }),
    );
  });
});
