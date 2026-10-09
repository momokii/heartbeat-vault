import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TestRelease } from './test-release';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function renderComponent(): void {
  render(
    <MemoryRouter>
      <TestRelease switchId="9bc2f8e0-9b2f-4d14-ae5f-d8c7a0956d3f" />
    </MemoryRouter>,
  );
}

describe('TestRelease', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('sends a test release and reports the channel count', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(jsonResponse({ ok: true, channelCount: 2 }));

    renderComponent();

    fireEvent.click(screen.getByRole('button', { name: 'Send test release' }));

    expect(
      await screen.findByText('Test release sent to 2 channels. No real release happened.'),
    ).toBeVisible();
    const [, init] = fetchMock.mock.calls[0]!;
    expect(init).toMatchObject({ method: 'POST', credentials: 'include' });
    expect(JSON.parse(String(init?.body ?? '{}'))).toEqual({});
  });

  it('asks for an authenticator code after a step-up challenge and retries with it', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(jsonResponse({ error: 'totp_required' }, 403))
      .mockResolvedValueOnce(jsonResponse({ ok: true, channelCount: 1 }));

    renderComponent();

    fireEvent.click(screen.getByRole('button', { name: 'Send test release' }));
    expect(
      await screen.findByText('Enter your authenticator code to authorize the test release.'),
    ).toBeVisible();
    fireEvent.change(screen.getByLabelText('Authenticator code'), {
      target: { value: '123456' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send test release' }));

    expect(
      await screen.findByText('Test release sent to 1 channel. No real release happened.'),
    ).toBeVisible();
    const [, retryInit] = fetchMock.mock.calls[1]!;
    expect(JSON.parse(String(retryInit?.body ?? '{}'))).toEqual({ totpCode: '123456' });
  });

  it('explains rate limits and delivery failures', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      jsonResponse({ error: 'rate_limited' }, 429),
    );

    renderComponent();

    fireEvent.click(screen.getByRole('button', { name: 'Send test release' }));

    expect(await screen.findByText('Too many test releases. Try again later.')).toBeVisible();
  });
});
