import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AdminActivityPage } from './admin-activity';

const firstPage = {
  items: [
    {
      id: 42,
      timestamp: '2026-09-26T12:34:56.000Z',
      actorId: '11111111-1111-4111-8111-111111111111',
      actorEmail: 'admin@example.test',
      action: 'invite_created',
      target: 'new-user@example.test',
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

describe('AdminActivityPage', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('shows a loading state while the initial activity request is pending', async () => {
    const pendingActivity = deferred<Response>();
    vi.spyOn(globalThis, 'fetch').mockImplementationOnce(() => pendingActivity.promise);

    renderPage();

    expect(screen.getByText('Loading activity…')).toBeVisible();
    pendingActivity.resolve(jsonResponse(firstPage));
    expect(await screen.findByText('invite_created')).toBeVisible();
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

  it('applies action and text filters only after the filter form is submitted', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(jsonResponse(firstPage))
      .mockResolvedValueOnce(jsonResponse({ items: [], nextBeforeId: null }));

    renderPage();

    await screen.findByText('invite_created');
    fireEvent.change(screen.getByLabelText('Action'), { target: { value: 'auth_login' } });
    fireEvent.change(screen.getByLabelText('Search activity'), {
      target: { value: 'admin@example.test' },
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const filterForm = screen.getByRole('button', { name: 'Apply filters' }).closest('form');
    if (!(filterForm instanceof HTMLFormElement)) throw new Error('Filter form is unavailable');
    fireEvent.submit(filterForm);

    expect(await screen.findByText('No activity matches your filters.')).toBeVisible();
    expect(fetchMock).toHaveBeenLastCalledWith(
      '/api/audit-log?action=auth_login&q=admin%40example.test',
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

    expect(await screen.findByText('invite_created')).toBeVisible();
    expect(screen.getByText('new-user@example.test')).toBeVisible();
    expect(screen.getByText('admin@example.test')).toBeVisible();
    expect(screen.getByText('System')).toBeVisible();
    expect(screen.queryByText('must-not-render')).not.toBeInTheDocument();
    expect(screen.queryByText('192.0.2.1')).not.toBeInTheDocument();
    expect(screen.queryByText('request-must-not-render')).not.toBeInTheDocument();
  });

  it('clears filters and reloads the first page when reset is selected', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(jsonResponse(firstPage))
      .mockResolvedValueOnce(jsonResponse({ items: [], nextBeforeId: null }))
      .mockResolvedValueOnce(jsonResponse(firstPage));

    renderPage();

    await screen.findByText('invite_created');
    fireEvent.change(screen.getByLabelText('Action'), { target: { value: 'auth_login' } });
    fireEvent.change(screen.getByLabelText('Search activity'), {
      target: { value: 'admin@example.test' },
    });
    const filterForm = screen.getByRole('button', { name: 'Apply filters' }).closest('form');
    if (!(filterForm instanceof HTMLFormElement)) throw new Error('Filter form is unavailable');
    fireEvent.submit(filterForm);
    await screen.findByText('No activity matches your filters.');

    fireEvent.click(screen.getByRole('button', { name: 'Reset' }));

    expect(await screen.findByText('invite_created')).toBeVisible();
    expect(screen.getByLabelText('Action')).toHaveValue('');
    expect(screen.getByLabelText('Search activity')).toHaveValue('');
    expect(fetchMock).toHaveBeenLastCalledWith(
      '/api/audit-log',
      expect.objectContaining({ method: 'GET', credentials: 'include' }),
    );
  });

  it('appends the next cursor page when more activity is requested', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(jsonResponse(firstPage))
      .mockResolvedValueOnce(jsonResponse(secondPage));

    renderPage();

    await screen.findByText('invite_created');
    fireEvent.click(screen.getByRole('button', { name: 'Load more' }));

    expect(await screen.findByText('auth_login')).toBeVisible();
    expect(screen.getByText('invite_created')).toBeVisible();
    expect(fetchMock).toHaveBeenLastCalledWith(
      '/api/audit-log?beforeId=42',
      expect.objectContaining({ method: 'GET', credentials: 'include' }),
    );
  });
});
