import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AdminReportsPage } from './admin-reports';

const ledgerPage = {
  items: [
    {
      id: '11111111-1111-4111-8111-111111111111',
      createdAt: '2026-09-26T12:00:00.000Z',
      requestedByEmail: 'admin@example.test',
      scopeType: 'switch',
      switchId: '22222222-2222-4222-8222-222222222222',
      switchTitle: 'legacy-plan',
      format: 'json',
      filters: {
        category: 'switch',
        from: '2026-09-01T00:00:00.000Z',
        to: '2026-09-26T00:00:00.000Z',
      },
      rowCount: 42,
      status: 'success',
      errorCode: null,
    },
    {
      id: '33333333-3333-4333-8333-333333333333',
      createdAt: '2026-09-25T12:00:00.000Z',
      requestedByEmail: 'admin@example.test',
      scopeType: 'global',
      switchId: null,
      switchTitle: null,
      format: 'csv',
      filters: {},
      rowCount: null,
      status: 'failed',
      errorCode: 'export_limit_exceeded',
    },
  ],
  nextBeforeId: null,
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function renderPage(): void {
  render(
    <MemoryRouter>
      <AdminReportsPage />
    </MemoryRouter>,
  );
}

describe('AdminReportsPage', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('lists exported reports with type, actor, format, range, and status', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(jsonResponse(ledgerPage))
      .mockResolvedValueOnce(jsonResponse([]));

    renderPage();

    expect(await screen.findByText('Switch — legacy-plan')).toBeVisible();
    expect(screen.getAllByText('Audit log').length).toBeGreaterThan(0);
    expect(screen.getAllByText('admin@example.test').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Success').length).toBeGreaterThan(0);
    expect(screen.getByText('Failed (export_limit_exceeded)')).toBeVisible();
    expect(screen.getByText('json')).toBeVisible();
    expect(screen.getByText('csv')).toBeVisible();
    expect(screen.getByText('42')).toBeVisible();
  });

  it('filters the ledger by report type', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(jsonResponse(ledgerPage))
      .mockResolvedValueOnce(jsonResponse([]))
      .mockResolvedValueOnce(jsonResponse({ items: [], nextBeforeId: null }));

    renderPage();

    await screen.findByText('Switch — legacy-plan');
    fireEvent.change(screen.getByLabelText('Report type'), { target: { value: 'switch' } });

    await waitFor(() =>
      expect(fetchMock).toHaveBeenLastCalledWith(
        '/api/reports/exports?scope=switch',
        expect.objectContaining({ method: 'GET', credentials: 'include' }),
      ),
    );
  });

  it('filters by a specific switch and keeps the switch on load more', async () => {
    const switchId = '22222222-2222-4222-8222-222222222222';
    const filteredPage = { items: [ledgerPage.items[0]], nextBeforeId: 7 };
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(jsonResponse(ledgerPage))
      .mockResolvedValueOnce(
        jsonResponse([{ id: switchId, title: 'legacy-plan', ownerEmail: 'owner@example.test' }]),
      )
      .mockResolvedValueOnce(jsonResponse(filteredPage))
      .mockResolvedValueOnce(jsonResponse(filteredPage))
      .mockResolvedValueOnce(jsonResponse({ items: [], nextBeforeId: null }));

    renderPage();

    await screen.findByText('Switch — legacy-plan');
    fireEvent.change(screen.getByLabelText('Report type'), { target: { value: 'switch' } });
    await screen.findByLabelText('Switch');
    fireEvent.change(screen.getByLabelText('Switch'), { target: { value: switchId } });

    await waitFor(() =>
      expect(fetchMock).toHaveBeenLastCalledWith(
        `/api/reports/exports?scope=switch&switchId=${switchId}`,
        expect.objectContaining({ method: 'GET', credentials: 'include' }),
      ),
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Load more' }));
    await waitFor(() =>
      expect(fetchMock).toHaveBeenLastCalledWith(
        `/api/reports/exports?beforeId=7&scope=switch&switchId=${switchId}`,
        expect.objectContaining({ method: 'GET', credentials: 'include' }),
      ),
    );
  });

  it('opens the export dialog and reloads the ledger after a successful export', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(jsonResponse(ledgerPage))
      .mockResolvedValueOnce(jsonResponse([]))
      .mockResolvedValueOnce(jsonResponse([]))
      .mockResolvedValueOnce(new Response('id', { headers: { 'content-type': 'text/csv' } }))
      .mockResolvedValueOnce(jsonResponse(ledgerPage));
    vi.stubGlobal('URL', {
      createObjectURL: vi.fn(() => 'blob:report-export'),
      revokeObjectURL: vi.fn(),
    });
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);

    renderPage();

    await screen.findByText('Switch — legacy-plan');
    fireEvent.click(screen.getByRole('button', { name: 'Export…' }));
    expect(await screen.findByText('Export report')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Export' }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(5));
    expect(fetchMock).toHaveBeenNthCalledWith(
      4,
      '/api/reports/exports',
      expect.objectContaining({ method: 'POST', credentials: 'include' }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      5,
      '/api/reports/exports',
      expect.objectContaining({ method: 'GET', credentials: 'include' }),
    );
    expect(await screen.findByText('Switch — legacy-plan')).toBeVisible();
  });

  it('shows the empty state before any exports exist', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(jsonResponse({ items: [], nextBeforeId: null }))
      .mockResolvedValueOnce(jsonResponse([]));

    renderPage();

    expect(
      await screen.findByText('No exports recorded yet. Use Export… to create the first one.'),
    ).toBeVisible();
  });

  it('shows administrator access feedback when the reports request is forbidden', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(jsonResponse({ error: 'forbidden' }, 403));

    renderPage();

    expect(await screen.findByText('Administrator access required')).toBeVisible();
  });
});
