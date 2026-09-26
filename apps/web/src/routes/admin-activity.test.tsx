import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AdminActivityPage } from './admin-activity';
import { applyReportDateShortcut } from '@/lib/reports-contract';

const firstPage = {
  items: [
    {
      id: 42,
      timestamp: '2026-09-26T12:34:56.000Z',
      actorId: '11111111-1111-4111-8111-111111111111',
      actorEmail: 'admin@example.test',
      action: 'invite_created',
      target: 'new-user@example.test',
      category: 'invite',
      details: { inviteId: 'invitation-42' },
      hash: 'must-not-render',
      ip: '192.0.2.1',
      requestId: 'request-must-not-render',
    },
  ],
  nextBeforeId: 42,
};

const secondPage = {
  items: [
    {
      id: 41,
      timestamp: '2026-09-26T11:34:56.000Z',
      actorId: null,
      actorEmail: null,
      action: 'auth_login',
      target: null,
      category: 'auth',
      details: {},
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

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T | PromiseLike<T>) => void;
} {
  let resolve: (value: T | PromiseLike<T>) => void = () => undefined;
  const promise = new Promise<T>(resolvePromise => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function renderPage(): void {
  render(
    <MemoryRouter>
      <AdminActivityPage />
    </MemoryRouter>,
  );
}

function encodedLocalDate(value: string): string {
  return encodeURIComponent(new Date(value).toISOString());
}

describe('AdminActivityPage', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('shows a loading state while the initial activity request is pending', async () => {
    const pendingActivity = deferred<Response>();
    vi.spyOn(globalThis, 'fetch').mockImplementationOnce(() => pendingActivity.promise);

    renderPage();

    expect(screen.getByText('Loading activity…')).toBeVisible();
    pendingActivity.resolve(jsonResponse(firstPage));
    expect(await screen.findByText('Invitation created')).toBeVisible();
  });

  it('shows administrator access feedback when the activity request is forbidden', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(jsonResponse({ error: 'forbidden' }, 403));

    renderPage();

    expect(await screen.findByText('Administrator access required')).toBeVisible();
  });

  it('shows administrator access feedback when the activity request is unauthorized', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      jsonResponse({ error: 'unauthorized' }, 401),
    );

    renderPage();

    expect(await screen.findByText('Administrator access required')).toBeVisible();
  });

  it('shows generic availability feedback when the activity request fails', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      jsonResponse({ error: 'unavailable' }, 500),
    );

    renderPage();

    expect(await screen.findByText('Activity log unavailable')).toBeVisible();
  });

  it('applies search, category, and date filters only after the filter form is submitted', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(jsonResponse(firstPage))
      .mockResolvedValueOnce(jsonResponse({ items: [], nextBeforeId: null }));

    renderPage();

    await screen.findByText('Invitation created');
    fireEvent.change(screen.getByLabelText('Search activity'), {
      target: { value: 'admin@example.test' },
    });
    fireEvent.change(screen.getByLabelText('Category'), { target: { value: 'invite' } });
    fireEvent.change(screen.getByLabelText('From'), { target: { value: '2026-09-25T10:30' } });
    fireEvent.change(screen.getByLabelText('To'), { target: { value: '2026-09-26T10:30' } });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const filterForm = screen.getByRole('button', { name: 'Apply filters' }).closest('form');
    if (!(filterForm instanceof HTMLFormElement)) throw new Error('Filter form is unavailable');
    fireEvent.submit(filterForm);

    expect(await screen.findByText('No activity matches your filters.')).toBeVisible();
    expect(fetchMock).toHaveBeenLastCalledWith(
      `/api/audit-log?q=admin%40example.test&category=invite&from=${encodedLocalDate('2026-09-25T10:30')}&to=${encodedLocalDate('2026-09-26T10:30')}&limit=10`,
      expect.objectContaining({ method: 'GET', credentials: 'include' }),
    );
  });

  it('renders safe row details with a system fallback when no actor email exists', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      jsonResponse({
        items: [...firstPage.items, ...secondPage.items],
        nextBeforeId: null,
      }),
    );

    renderPage();

    expect(await screen.findByText('Invitation created')).toBeVisible();
    expect(screen.getByText('new-user@example.test')).toBeVisible();
    expect(screen.getByText('admin@example.test')).toBeVisible();
    expect(screen.getByText('System', { selector: 'p' })).toBeVisible();
    expect(screen.queryByText('must-not-render')).not.toBeInTheDocument();
    expect(screen.queryByText('192.0.2.1')).not.toBeInTheDocument();
    expect(screen.queryByText('request-must-not-render')).not.toBeInTheDocument();
  });

  it('renders audit details only when the row disclosure is expanded', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(jsonResponse(firstPage));

    renderPage();

    expect(await screen.findByText('Invitation created')).toBeVisible();
    expect(screen.getByText(/"inviteId"/)).not.toBeVisible();
    fireEvent.click(screen.getByText('Details'));
    expect(screen.getByText(/"inviteId": "invitation-42"/)).toBeVisible();
  });

  it('keeps applied category and date filters when navigating to the next page', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(jsonResponse(firstPage))
      .mockResolvedValueOnce(jsonResponse(firstPage))
      .mockResolvedValueOnce(jsonResponse(secondPage));

    renderPage();

    await screen.findByText('Invitation created');
    fireEvent.change(screen.getByLabelText('Category'), { target: { value: 'invite' } });
    fireEvent.change(screen.getByLabelText('From'), { target: { value: '2026-09-25T10:30' } });
    fireEvent.click(screen.getByRole('button', { name: 'Apply filters' }));
    await screen.findByText('Invitation created');
    fireEvent.change(screen.getByLabelText('Category'), { target: { value: 'auth' } });
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));

    expect(await screen.findByText('Signed in')).toBeVisible();
    expect(fetchMock).toHaveBeenLastCalledWith(
      `/api/audit-log?beforeId=42&category=invite&from=${encodedLocalDate('2026-09-25T10:30')}&limit=10`,
      expect.objectContaining({ method: 'GET', credentials: 'include' }),
    );
  });

  it('exports through the report dialog and records the request', async () => {
    const csvResponse = new Response('id,timestamp', { headers: { 'content-type': 'text/csv' } });
    const csvBlob = vi.spyOn(csvResponse, 'blob');
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(jsonResponse(firstPage))
      .mockResolvedValueOnce(jsonResponse([]))
      .mockResolvedValueOnce(csvResponse);
    vi.stubGlobal('URL', {
      createObjectURL: vi.fn(() => 'blob:activity-export'),
      revokeObjectURL: vi.fn(),
    });
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);

    renderPage();

    await screen.findByText('Invitation created');
    fireEvent.click(screen.getByRole('button', { name: 'Export…' }));
    expect(await screen.findByText('Export report')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Today' }));
    fireEvent.click(screen.getByRole('button', { name: 'Export' }));

    await waitFor(() => expect(csvBlob).toHaveBeenCalledOnce());
    const lastCall = fetchMock.mock.calls.at(-1)!;
    expect(lastCall[0]).toBe('/api/reports/exports');
    expect(lastCall[1]).toMatchObject({ method: 'POST', credentials: 'include' });
    const exportedBody = JSON.parse(String(lastCall[1]?.body ?? '{}')) as {
      format: string;
      scope: string;
      from: string;
      to: string;
    };
    expect(exportedBody).toMatchObject({ format: 'csv', scope: 'global' });
    expect(exportedBody.from).toBe(new Date(applyReportDateShortcut('today').from).toISOString());
    expect(exportedBody.to).toBe(new Date(applyReportDateShortcut('today').to).toISOString());
  });

  it('clears filters and reloads the first page when reset is selected', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(jsonResponse(firstPage))
      .mockResolvedValueOnce(jsonResponse({ items: [], nextBeforeId: null }))
      .mockResolvedValueOnce(jsonResponse(firstPage));

    renderPage();

    await screen.findByText('Invitation created');
    fireEvent.change(screen.getByLabelText('Search activity'), {
      target: { value: 'admin@example.test' },
    });
    const filterForm = screen.getByRole('button', { name: 'Apply filters' }).closest('form');
    if (!(filterForm instanceof HTMLFormElement)) throw new Error('Filter form is unavailable');
    fireEvent.submit(filterForm);
    await screen.findByText('No activity matches your filters.');

    fireEvent.click(screen.getByRole('button', { name: 'Reset' }));

    expect(await screen.findByText('Invitation created')).toBeVisible();
    expect(screen.getByLabelText('Search activity')).toHaveValue('');
    expect(screen.getByLabelText('Category')).toHaveValue('');
    expect(screen.getByLabelText('From')).toHaveValue('');
    expect(screen.getByLabelText('To')).toHaveValue('');
    expect(fetchMock).toHaveBeenLastCalledWith(
      '/api/audit-log?limit=10',
      expect.objectContaining({ method: 'GET', credentials: 'include' }),
    );
  });

  it('paginates with next and previous while keeping the chosen page size', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(jsonResponse(firstPage))
      .mockResolvedValueOnce(jsonResponse(secondPage))
      .mockResolvedValueOnce(jsonResponse(firstPage))
      .mockResolvedValueOnce(jsonResponse(firstPage));

    renderPage();

    await screen.findByText('Invitation created');
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));

    expect(await screen.findByText('Signed in')).toBeVisible();
    expect(screen.queryByText('Invitation created')).not.toBeInTheDocument();
    expect(fetchMock).toHaveBeenLastCalledWith(
      '/api/audit-log?beforeId=42&limit=10',
      expect.objectContaining({ method: 'GET', credentials: 'include' }),
    );

    fireEvent.click(screen.getByRole('button', { name: 'Previous' }));
    expect(await screen.findByText('Invitation created')).toBeVisible();
    expect(fetchMock).toHaveBeenLastCalledWith(
      '/api/audit-log?limit=10',
      expect.objectContaining({ method: 'GET', credentials: 'include' }),
    );

    fireEvent.change(screen.getByLabelText('Rows per page'), { target: { value: '25' } });
    await screen.findByText('Invitation created');
    expect(fetchMock).toHaveBeenLastCalledWith(
      '/api/audit-log?limit=25',
      expect.objectContaining({ method: 'GET', credentials: 'include' }),
    );
  });
});
