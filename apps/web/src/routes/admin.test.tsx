import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AdminPage } from './admin';

const existingUser = {
  id: '11111111-1111-4111-8111-111111111111',
  email: 'existing@example.test',
  role: 'admin',
  created_at: '2026-09-21T00:00:00.000Z',
};
const invitedUser = {
  id: '22222222-2222-4222-8222-222222222222',
  email: 'invited@example.test',
  role: 'user',
  created_at: '2026-09-21T00:01:00.000Z',
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve: (value: T | PromiseLike<T>) => void = () => undefined;
  let reject: (reason?: unknown) => void = () => undefined;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe('AdminPage', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('shows only the late failed invite feedback and reloads users after the successful invite', async () => {
    const firstInvite = deferred<Response>();
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(jsonResponse([existingUser]))
      .mockImplementationOnce(() => firstInvite.promise)
      .mockResolvedValueOnce(
        jsonResponse({ id: '33333333-3333-4333-8333-333333333333', token: 'test-token' }, 201),
      )
      .mockResolvedValueOnce(jsonResponse([existingUser, invitedUser]));

    render(
      <MemoryRouter>
        <AdminPage />
      </MemoryRouter>,
    );

    await screen.findByText(existingUser.email);
    const form = screen.getByLabelText('Email address').closest('form');
    if (!(form instanceof HTMLFormElement)) throw new Error('Invite form is unavailable');

    fireEvent.change(screen.getByLabelText('Email address'), {
      target: { value: invitedUser.email },
    });
    act(() => {
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });

    await screen.findByText(/Invitation token — copy and share securely now:/);
    expect(screen.getByRole('status')).toHaveTextContent(
      'Invitation created. Copy the token before leaving this page.',
    );
    expect(screen.getByLabelText('Email address')).toHaveValue('');
    expect(await screen.findByText(invitedUser.email)).toBeInTheDocument();
    firstInvite.reject(new Error('Network failure'));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'The invitation could not be created. Try again.',
    );
    expect(
      screen.queryByText(/Invitation token — copy and share securely now:/),
    ).not.toBeInTheDocument();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(fetchMock).toHaveBeenNthCalledWith(
      4,
      '/api/users',
      expect.objectContaining({ method: 'GET' }),
    );
  });

  it('posts the selected user reset and shows its token and encoded link after 201', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(jsonResponse([existingUser, invitedUser]))
      .mockResolvedValueOnce(
        jsonResponse(
          {
            id: invitedUser.id,
            token: 'reset token',
            expiresAt: '2026-09-22T00:00:00.000Z',
          },
          201,
        ),
      );

    render(
      <MemoryRouter>
        <AdminPage />
      </MemoryRouter>,
    );

    await screen.findByText(invitedUser.email);
    expect(
      screen.queryByText(/Password reset token — copy and share securely now:/),
    ).not.toBeInTheDocument();

    const invitedUserRow = screen.getByText(invitedUser.email).closest('li');
    if (!(invitedUserRow instanceof HTMLLIElement))
      throw new Error('Invited user row is unavailable');
    fireEvent.click(within(invitedUserRow).getByRole('button', { name: 'Reset password' }));

    expect(
      await screen.findByText(/Password reset token — copy and share securely now: reset token/),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        (_, element) =>
          element?.textContent ===
          `Reset link: ${window.location.origin}/account/reset?token=reset%20token`,
      ),
    ).toBeInTheDocument();
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      `/api/users/${invitedUser.id}/password-reset`,
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('only disables the selected user password reset action while it is pending', async () => {
    const pendingReset = deferred<Response>();
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(jsonResponse([existingUser, invitedUser]))
      .mockImplementationOnce(() => pendingReset.promise);

    render(
      <MemoryRouter>
        <AdminPage />
      </MemoryRouter>,
    );

    await screen.findByText(invitedUser.email);
    const existingUserRow = screen.getByText(existingUser.email).closest('li');
    if (!(existingUserRow instanceof HTMLLIElement))
      throw new Error('Existing user row is unavailable');
    fireEvent.click(within(existingUserRow).getByRole('button', { name: 'Reset password' }));

    expect(screen.getByRole('button', { name: 'Creating password reset…' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Reset password' })).toBeEnabled();

    pendingReset.resolve(
      jsonResponse(
        {
          id: existingUser.id,
          token: 'pending-token',
          expiresAt: '2026-09-22T00:00:00.000Z',
        },
        201,
      ),
    );
    await screen.findByText(/Password reset token — copy and share securely now: pending-token/);
  });

  it('clears the password reset token after a failed request and shows a generic error', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(jsonResponse([existingUser]))
      .mockResolvedValueOnce(
        jsonResponse(
          {
            id: existingUser.id,
            token: 'first-reset-token',
            expiresAt: '2026-09-22T00:00:00.000Z',
          },
          201,
        ),
      )
      .mockResolvedValueOnce(jsonResponse({ error: 'unavailable' }, 500));

    render(
      <MemoryRouter>
        <AdminPage />
      </MemoryRouter>,
    );

    await screen.findByText(existingUser.email);
    fireEvent.click(screen.getByRole('button', { name: 'Reset password' }));
    await screen.findByText(
      /Password reset token — copy and share securely now: first-reset-token/,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Reset password' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'The password reset could not be created. Try again.',
    );
    expect(screen.queryByText(/first-reset-token/)).not.toBeInTheDocument();
  });
});
