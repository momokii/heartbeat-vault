import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { SwitchDetailPage } from '@/routes/switch-detail';

const switchItem = {
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
  createdAt: '2026-01-01T03:04:05.000Z',
  updatedAt: '2026-01-02T03:04:05.000Z',
};

const firstHistoryPage = {
  items: [
    {
      id: 12,
      timestamp: '2026-01-03T03:04:05.000Z',
      actorId: 'actor-1',
      actorEmail: 'owner@example.test',
      action: 'switch_armed',
      category: 'switch',
      target: switchItem.id,
      details: { source: 'manual' },
      hash: 'must-not-render',
      ip: '192.0.2.1',
    },
  ],
  nextBeforeId: 12,
};

const secondHistoryPage = {
  items: [
    {
      id: 11,
      timestamp: '2026-01-02T03:04:05.000Z',
      actorId: null,
      actorEmail: null,
      action: 'heartbeat_checkin',
      category: 'heartbeat',
      target: switchItem.id,
      details: {},
    },
  ],
  nextBeforeId: null,
};

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
}

function renderPage(): void {
  render(
    <MemoryRouter initialEntries={[`/switches/${switchItem.id}`]}>
      <Routes>
        <Route path="/switches/:id" element={<SwitchDetailPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

function encodedLocalDate(value: string): string {
  return encodeURIComponent(new Date(value).toISOString());
}

describe('SwitchHistory', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('propagates applied category and date filters to history pagination', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(jsonResponse(switchItem))
      .mockResolvedValueOnce(jsonResponse(firstHistoryPage))
      .mockResolvedValueOnce(jsonResponse(firstHistoryPage))
      .mockResolvedValueOnce(jsonResponse(secondHistoryPage));

    renderPage();

    expect(await screen.findByText('Switch armed')).toBeVisible();
    fireEvent.change(screen.getByLabelText('Category'), { target: { value: 'switch' } });
    fireEvent.change(screen.getByLabelText('From'), { target: { value: '2026-01-02T03:04' } });
    fireEvent.click(screen.getByRole('button', { name: 'Apply filters' }));
    await screen.findByText('Switch armed');
    fireEvent.change(screen.getByLabelText('Category'), { target: { value: 'heartbeat' } });
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));

    expect(await screen.findByText('Heartbeat checked in')).toBeVisible();
    expect(fetchMock).toHaveBeenLastCalledWith(
      `/api/switches/${switchItem.id}/audit?beforeId=12&category=switch&from=${encodedLocalDate('2026-01-02T03:04')}&limit=10`,
      expect.objectContaining({ method: 'GET', credentials: 'include' }),
    );
  });

  it('shows owner-visible sanitized details without administrator export controls', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(jsonResponse(switchItem))
      .mockResolvedValueOnce(jsonResponse(firstHistoryPage));

    renderPage();

    expect(await screen.findByText('owner@example.test')).toBeVisible();
    expect(screen.getByText(/"source"/)).not.toBeVisible();
    fireEvent.click(screen.getByText('Details'));
    expect(screen.getByText(/"source": "manual"/)).toBeVisible();
    expect(screen.queryByText('must-not-render')).not.toBeInTheDocument();
    expect(screen.queryByText('192.0.2.1')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Export/ })).not.toBeInTheDocument();
  });
});
