import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { HomePage } from './home';

const user = {
  id: '4fdb52d6-31dd-4e7d-aedb-e7f694468f4a',
  email: 'admin@example.com',
  role: 'admin',
};

const switches = [
  {
    id: '9bc2f8e0-9b2f-4d14-ae5f-d8c7a0956d3f',
    title: 'Family plan',
    mode: 'direct_delivery',
    status: 'active',
    heartbeatIntervalHours: 168,
    graceWindowHours: 24,
    dryRun: false,
    releasePolicy: 'fail_safe',
    heartbeatStartedAt: '2026-01-03T03:04:05.000Z',
    nextDeadline: '2026-01-10T03:04:05.000Z',
    createdAt: '2026-01-01T03:04:05.000Z',
    updatedAt: '2026-01-02T03:04:05.000Z',
    ownerEmail: 'owner@example.com',
  },
  {
    id: '8b4bfa77-d7d8-4f2f-9e7e-9d0ba568175f',
    title: 'Paused plan',
    mode: 'asymmetric_key',
    status: 'paused',
    heartbeatIntervalHours: 336,
    graceWindowHours: 48,
    dryRun: false,
    releasePolicy: 'fail_safe',
    heartbeatStartedAt: null,
    nextDeadline: null,
    createdAt: '2026-01-04T03:04:05.000Z',
    updatedAt: '2026-01-05T03:04:05.000Z',
    ownerEmail: 'owner@example.com',
  },
  {
    id: 'd9a422d1-af0f-4b13-b822-0829e080529a',
    title: 'Released archive',
    mode: 'direct_delivery',
    status: 'released',
    heartbeatIntervalHours: 720,
    graceWindowHours: 72,
    dryRun: false,
    releasePolicy: 'fail_safe',
    heartbeatStartedAt: '2026-01-06T03:04:05.000Z',
    nextDeadline: null,
    createdAt: '2026-01-06T03:04:05.000Z',
    updatedAt: '2026-01-07T03:04:05.000Z',
    ownerEmail: 'owner@example.com',
  },
];

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
}

function mockDashboard(items = switches) {
  return vi
    .spyOn(globalThis, 'fetch')
    .mockResolvedValueOnce(jsonResponse(user))
    .mockResolvedValueOnce(jsonResponse(items));
}

function renderPage(): void {
  render(
    <MemoryRouter>
      <HomePage />
    </MemoryRouter>,
  );
}

describe('HomePage', () => {
  afterEach(() => vi.restoreAllMocks());

  it('renders created and updated timestamps for loaded switches', async () => {
    mockDashboard();
    renderPage();

    await screen.findByText('Family plan');

    expect(screen.getAllByText(/Created:/)).toHaveLength(switches.length);
    expect(screen.getAllByText(/Updated:/)).toHaveLength(switches.length);
  });

  it('filters loaded switches by case-insensitive title text without another request', async () => {
    const fetchMock = mockDashboard();
    renderPage();

    fireEvent.change(await screen.findByLabelText('Search switches'), {
      target: { value: 'fAmIlY' },
    });

    expect(screen.getByText('Family plan')).toBeVisible();
    expect(screen.queryByText('Paused plan')).not.toBeInTheDocument();
    expect(screen.queryByText('Released archive')).not.toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('filters loaded switches by status', async () => {
    mockDashboard();
    renderPage();

    fireEvent.change(await screen.findByLabelText('Status'), { target: { value: 'released' } });

    expect(screen.getByText('Released archive')).toBeVisible();
    expect(screen.queryByText('Family plan')).not.toBeInTheDocument();
    expect(screen.queryByText('Paused plan')).not.toBeInTheDocument();
  });

  it('combines title text and status filters', async () => {
    mockDashboard();
    renderPage();

    fireEvent.change(await screen.findByLabelText('Search switches'), {
      target: { value: 'plan' },
    });
    fireEvent.change(screen.getByLabelText('Status'), { target: { value: 'paused' } });

    expect(screen.getByText('Paused plan')).toBeVisible();
    expect(screen.queryByText('Family plan')).not.toBeInTheDocument();
    expect(screen.queryByText('Released archive')).not.toBeInTheDocument();
  });

  it('shows a neutral empty state when filters match no loaded switches', async () => {
    mockDashboard();
    renderPage();

    fireEvent.change(await screen.findByLabelText('Search switches'), {
      target: { value: 'missing' },
    });

    expect(screen.getByText('No switches match your filters.')).toBeVisible();
    expect(screen.queryByText('Family plan')).not.toBeInTheDocument();
  });

  it('shows the owner supplied by the administrator all-switch response', async () => {
    const fetchMock = mockDashboard();
    renderPage();

    expect(await screen.findAllByText('Owner: owner@example.com')).toHaveLength(switches.length);
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      '/api/switches?all=1',
      expect.objectContaining({ credentials: 'include' }),
    );
  });
});
