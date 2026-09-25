import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { SwitchDetailPage } from './switch-detail';

const item = {
  id: '9bc2f8e0-9b2f-4d14-ae5f-d8c7a0956d3f',
  title: 'Recovery plan',
  mode: 'direct_delivery',
  status: 'paused',
  heartbeatIntervalHours: 168,
  graceWindowHours: 24,
  dryRun: false,
  releasePolicy: 'fail_deadly',
  heartbeatStartedAt: null,
  nextDeadline: null,
};

function renderPage(): void {
  render(
    <MemoryRouter initialEntries={[`/switches/${item.id}`]}>
      <Routes>
        <Route path="/" element={<p>Dashboard</p>} />
        <Route path="/switches/:id" element={<SwitchDetailPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
}

describe('SwitchDetailPage', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('renders guidance disclosures across arm, setup, check-in, triggers, and settings', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(item));
    renderPage();

    expect(
      await screen.findByRole('button', { name: 'What is arming this switch?' }),
    ).toBeVisible();
    expect(screen.getByRole('button', { name: 'What is a recipient invitation?' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'What is checking in?' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'What is the fixed-date trigger?' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'What is deleting this switch?' })).toBeVisible();

    fireEvent.click(screen.getByRole('button', { name: 'What is arming this switch?' }));
    expect(
      screen.getByRole('region', { name: 'arming this switch explanation' }),
    ).toHaveTextContent('fail_deadly');
  });

  it('keeps fail_deadly arming on the existing confirmation contract', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(jsonResponse(item))
      .mockResolvedValueOnce(jsonResponse({ ok: true, status: 'active' }));
    renderPage();

    fireEvent.click(await screen.findByRole('button', { name: 'Arm switch' }));
    expect(await screen.findByText(/Switch armed/)).toBeVisible();

    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      `/api/switches/${item.id}/arm`,
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ confirm: true, failDeadlyConfirmation: item.id }),
        credentials: 'include',
      }),
    );
  });
});
