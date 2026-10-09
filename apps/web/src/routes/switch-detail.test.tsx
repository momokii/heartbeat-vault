import { fireEvent, render, screen, waitFor } from '@testing-library/react';
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
  createdAt: '2026-01-01T03:04:05.000Z',
  updatedAt: '2026-01-02T03:04:05.000Z',
};

function renderPage(): void {
  renderPageWithItem(item);
}

function renderPageWithItem(switchItem: typeof item): void {
  render(
    <MemoryRouter initialEntries={[`/switches/${switchItem.id}`]}>
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

function errorResponse(status: number): Response {
  return new Response(null, { status });
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
      .mockResolvedValueOnce(jsonResponse({ items: [], nextBeforeId: null }))
      .mockResolvedValueOnce(jsonResponse({ ok: true, status: 'active' }));
    renderPage();

    fireEvent.click(await screen.findByRole('button', { name: 'Arm switch' }));
    expect(await screen.findByText(/Switch armed/)).toBeVisible();

    expect(fetchMock).toHaveBeenNthCalledWith(
      3,
      `/api/switches/${item.id}/arm`,
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ confirm: true, failDeadlyConfirmation: item.id }),
        credentials: 'include',
      }),
    );
  });

  it('shows loading history while the first audit page is pending', async () => {
    let resolveHistory: ((response: Response) => void) | undefined;
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(jsonResponse(item))
      .mockImplementationOnce(
        () =>
          new Promise(resolve => {
            resolveHistory = resolve;
          }),
      );
    renderPage();

    expect(await screen.findByText('Loading history…')).toBeVisible();
    resolveHistory?.(jsonResponse({ items: [], nextBeforeId: null }));
    expect(await screen.findByText('No recorded activity for this switch.')).toBeVisible();
  });

  it('loads, appends, and presents switch history without blocking lifecycle controls', async () => {
    let resolveMore: ((response: Response) => void) | undefined;
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(jsonResponse(item))
      .mockResolvedValueOnce(
        jsonResponse({
          items: [
            {
              id: 12,
              timestamp: '2026-01-03T03:04:05.000Z',
              actorId: 'actor-1',
              actorEmail: 'owner@example.test',
              action: 'switch_armed',
              target: item.id,
              category: 'switch',
              details: {},
            },
          ],
          nextBeforeId: 12,
        }),
      )
      .mockImplementationOnce(
        () =>
          new Promise(resolve => {
            resolveMore = resolve;
          }),
      );
    renderPage();

    expect(await screen.findByText('History')).toBeVisible();
    expect(screen.getByText('Switch armed')).toBeVisible();
    expect(screen.getByText(item.id)).toBeVisible();
    expect(screen.getByText('owner@example.test')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Arm switch' })).toBeEnabled();
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      `/api/switches/${item.id}/audit?limit=10`,
      expect.objectContaining({ credentials: 'include' }),
    );

    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    resolveMore?.(
      jsonResponse({
        items: [
          {
            id: 11,
            timestamp: '2026-01-02T03:04:05.000Z',
            actorId: null,
            actorEmail: null,
            action: 'switch_updated',
            target: null,
            category: 'switch',
            details: {},
          },
        ],
        nextBeforeId: null,
      }),
    );

    expect(await screen.findByText('Switch updated')).toBeVisible();
    expect(screen.getByText('Unknown actor')).toBeVisible();
    expect(screen.queryByText('Switch armed')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Previous' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled();
  });

  it('keeps prior history and controls available when another audit page fails', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(jsonResponse(item))
      .mockResolvedValueOnce(
        jsonResponse({
          items: [
            {
              id: 12,
              timestamp: '2026-01-03T03:04:05.000Z',
              actorId: 'actor-1',
              actorEmail: 'owner@example.test',
              action: 'switch_armed',
              target: item.id,
              category: 'switch',
              details: {},
            },
          ],
          nextBeforeId: 12,
        }),
      )
      .mockResolvedValueOnce(errorResponse(500));
    renderPage();

    fireEvent.click(await screen.findByRole('button', { name: 'Next' }));
    expect(await screen.findByText('History is temporarily unavailable.')).toBeVisible();
    expect(screen.getByText('Switch armed')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Arm switch' })).toBeEnabled();
  });

  it('shows an inline unavailable message when the first audit page fails', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(jsonResponse(item))
      .mockResolvedValueOnce(errorResponse(500));
    renderPage();

    expect(await screen.findByText('History is temporarily unavailable.')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Arm switch' })).toBeEnabled();
    expect(screen.queryByRole('button', { name: 'Load more' })).not.toBeInTheDocument();
  });

  it('shows empty history independently from the loaded switch', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(jsonResponse(item))
      .mockResolvedValueOnce(jsonResponse({ items: [], nextBeforeId: null }));
    renderPage();

    expect(await screen.findByText('No recorded activity for this switch.')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Arm switch' })).toBeEnabled();
  });

  it('lists delegates for an owner with their email, start date, and revoke control', async () => {
    const ownerItem = { ...item, isOwner: true };
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(jsonResponse(ownerItem))
      .mockResolvedValueOnce(jsonResponse({ items: [], nextBeforeId: null }))
      .mockResolvedValueOnce(
        jsonResponse([
          {
            id: '2abec2f0-9b2f-4d14-ae5f-d8c7a0956d3f',
            email: 'delegate@example.test',
            createdAt: '2026-01-03T03:04:05.000Z',
          },
        ]),
      );
    renderPageWithItem(ownerItem);

    expect(await screen.findByText('delegate@example.test')).toBeVisible();
    expect(screen.getByText(/Since/)).toBeVisible();
    expect(screen.getByRole('button', { name: 'Revoke' })).toBeVisible();
  });

  it('grants a delegate after validating and submitting their email', async () => {
    const ownerItem = { ...item, isOwner: true };
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(jsonResponse(ownerItem))
      .mockResolvedValueOnce(jsonResponse({ items: [], nextBeforeId: null }))
      .mockResolvedValueOnce(jsonResponse([]))
      .mockResolvedValueOnce(
        jsonResponse({
          id: '2abec2f0-9b2f-4d14-ae5f-d8c7a0956d3f',
          delegateUserId: '3abec2f0-9b2f-4d14-ae5f-d8c7a0956d3f',
          createdAt: '2026-01-03T03:04:05.000Z',
        }),
      );
    renderPageWithItem(ownerItem);

    const input = await screen.findByLabelText('Delegate email');
    fireEvent.change(input, { target: { value: 'delegate@example.test' } });
    fireEvent.click(screen.getByRole('button', { name: 'Grant delegate access' }));

    expect(await screen.findByText('Delegate added.')).toBeVisible();
    expect(screen.getByText('delegate@example.test')).toBeVisible();
    expect(fetchMock).toHaveBeenNthCalledWith(
      4,
      `/api/switches/${item.id}/delegates`,
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ email: 'delegate@example.test' }),
      }),
    );
  });

  it('shows a readable grant error for an already assigned delegate', async () => {
    const ownerItem = { ...item, isOwner: true };
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(jsonResponse(ownerItem))
      .mockResolvedValueOnce(jsonResponse({ items: [], nextBeforeId: null }))
      .mockResolvedValueOnce(jsonResponse([]))
      .mockResolvedValueOnce(errorResponse(409));
    renderPageWithItem(ownerItem);

    fireEvent.change(await screen.findByLabelText('Delegate email'), {
      target: { value: 'delegate@example.test' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Grant delegate access' }));

    expect(
      await screen.findByText('That user is already a delegate for this switch.'),
    ).toBeVisible();
  });

  it('requires confirmation before revoking a delegate', async () => {
    const ownerItem = { ...item, isOwner: true };
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(jsonResponse(ownerItem))
      .mockResolvedValueOnce(jsonResponse({ items: [], nextBeforeId: null }))
      .mockResolvedValueOnce(
        jsonResponse([
          {
            id: '2abec2f0-9b2f-4d14-ae5f-d8c7a0956d3f',
            email: 'delegate@example.test',
            createdAt: '2026-01-03T03:04:05.000Z',
          },
        ]),
      )
      .mockResolvedValueOnce(jsonResponse({ ok: true }));
    renderPageWithItem(ownerItem);

    fireEvent.click(await screen.findByRole('button', { name: 'Revoke' }));
    expect(screen.getByRole('alertdialog', { name: /delegate@example.test/ })).toBeVisible();
    expect(fetchMock).toHaveBeenCalledTimes(3);

    fireEvent.click(screen.getByRole('button', { name: 'Revoke access' }));
    expect(await screen.findByText('Delegate revoked.')).toBeVisible();
    expect(screen.queryByText('delegate@example.test')).not.toBeInTheDocument();
  });

  it('hides delegate management from non-owners', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(jsonResponse({ ...item, isOwner: false }))
      .mockResolvedValueOnce(jsonResponse({ items: [], nextBeforeId: null }));
    renderPage();

    await screen.findByText('No recorded activity for this switch.');
    expect(screen.queryByText('Delegates')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Delegate email')).not.toBeInTheDocument();
  });

  it('preserves the switch missing state when the detail request returns 404', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(errorResponse(404))
      .mockResolvedValueOnce(jsonResponse({ items: [], nextBeforeId: null }));
    renderPage();

    expect(await screen.findByRole('heading', { name: 'Switch not found' })).toBeVisible();
    await waitFor(() => expect(screen.queryByText('History')).not.toBeInTheDocument());
  });
});
