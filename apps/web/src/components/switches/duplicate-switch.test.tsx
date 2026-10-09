import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DuplicateSwitch } from './duplicate-switch';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function LocationProbe(): React.JSX.Element {
  const location = useLocation();
  return <p data-testid="location">{location.pathname}</p>;
}

function renderComponent(): void {
  render(
    <MemoryRouter initialEntries={['/switches/source-id']}>
      <DuplicateSwitch switchId="source-id" switchTitle="Recovery plan" />
      <LocationProbe />
    </MemoryRouter>,
  );
}

describe('DuplicateSwitch', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('prefills a copy title and navigates to the duplicated switch on success', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      jsonResponse({
        id: '11111111-1111-4111-8111-111111111111',
        status: 'paused',
        dryRun: false,
      }),
    );

    renderComponent();

    expect(screen.getByLabelText('New switch title')).toHaveValue('Recovery plan copy');
    fireEvent.click(screen.getByRole('button', { name: 'Duplicate switch' }));

    await waitFor(() =>
      expect(screen.getByTestId('location')).toHaveTextContent(
        '/switches/11111111-1111-4111-8111-111111111111',
      ),
    );
    const [, init] = fetchMock.mock.calls[0]!;
    expect(init).toMatchObject({ method: 'POST', credentials: 'include' });
    expect(JSON.parse(String(init?.body ?? '{}'))).toEqual({ title: 'Recovery plan copy' });
  });

  it('shows a clear message when the title is taken', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      jsonResponse({ error: 'duplicate_title' }, 409),
    );

    renderComponent();

    fireEvent.click(screen.getByRole('button', { name: 'Duplicate switch' }));

    expect(await screen.findByText('A switch with that title already exists.')).toBeVisible();
    expect(screen.getByTestId('location')).toHaveTextContent('/switches/source-id');
  });
});
