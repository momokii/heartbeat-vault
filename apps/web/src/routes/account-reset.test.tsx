import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { AuthProvider } from '@/lib/auth';
import { AccountResetPage } from './account-reset';

const signedOutFetch = (reset: (input: unknown) => Promise<Response>) =>
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, _init) => {
    if (typeof input === 'string' && input === '/api/me') return new Response('', { status: 401 });
    return reset(input);
  });

function renderResetPage(initialEntry = '/account/reset') {
  return render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <AuthProvider>
        <Routes>
          <Route path="/" element={<p>Dashboard destination</p>} />
          <Route path="/account/reset" element={<AccountResetPage />} />
        </Routes>
      </AuthProvider>
    </MemoryRouter>,
  );
}

describe('AccountResetPage', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('prefills the token and submits the reset payload', async () => {
    const fetchMock = signedOutFetch(async input => {
      if (typeof input === 'string' && input.includes('/account/password/reset')) {
        return new Response(JSON.stringify({ ok: true }), {
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response('', { status: 500 });
    });
    renderResetPage('/account/reset?token=reset-token');

    expect(((await screen.findByLabelText('Reset token')) as HTMLInputElement).value).toBe(
      'reset-token',
    );
    fireEvent.change(screen.getByLabelText('New password'), {
      target: { value: 'longenoughpassword123' },
    });
    fireEvent.change(screen.getByLabelText('Confirm new password'), {
      target: { value: 'longenoughpassword123' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Reset password' }));

    expect(await screen.findByText('Your password has been reset.')).toBeVisible();
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/account/password/reset',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ token: 'reset-token', newPassword: 'longenoughpassword123' }),
        credentials: 'include',
      }),
    );
  });

  it('prevents submission when passwords do not match', async () => {
    const fetchMock = signedOutFetch(async () => new Response('', { status: 500 }));
    renderResetPage();

    fireEvent.change(await screen.findByLabelText('Reset token'), {
      target: { value: 'reset-token' },
    });
    fireEvent.change(screen.getByLabelText('New password'), {
      target: { value: 'longenoughpassword123' },
    });
    fireEvent.change(screen.getByLabelText('Confirm new password'), {
      target: { value: 'differentpassword123' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Reset password' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Passwords do not match.');
    expect(fetchMock).not.toHaveBeenCalledWith(
      '/api/account/password/reset',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('shows a success screen that explains all sessions were signed out', async () => {
    signedOutFetch(
      async () =>
        new Response(JSON.stringify({ ok: true }), {
          headers: { 'content-type': 'application/json' },
        }),
    );
    renderResetPage('/account/reset?token=reset-token');

    fireEvent.change(await screen.findByLabelText('New password'), {
      target: { value: 'longenoughpassword123' },
    });
    fireEvent.change(screen.getByLabelText('Confirm new password'), {
      target: { value: 'longenoughpassword123' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Reset password' }));

    expect(await screen.findByText('Your password has been reset.')).toBeVisible();
    expect(screen.getByText('All of your sessions have been signed out.')).toBeVisible();
    expect(screen.getByRole('link', { name: 'Continue to sign in' })).toHaveAttribute(
      'href',
      '/login',
    );
    expect(screen.queryByLabelText('Reset token')).not.toBeInTheDocument();
  });

  it('shows the rate-limit message when too many reset attempts occur', async () => {
    signedOutFetch(async () => new Response('', { status: 429 }));
    renderResetPage('/account/reset?token=reset-token');

    fireEvent.change(await screen.findByLabelText('New password'), {
      target: { value: 'longenoughpassword123' },
    });
    fireEvent.change(screen.getByLabelText('Confirm new password'), {
      target: { value: 'longenoughpassword123' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Reset password' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Too many attempts. Please wait before trying again.',
    );
  });

  it('redirects an already authenticated visitor to the dashboard', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async input => {
      if (typeof input === 'string' && input === '/api/me') {
        return new Response(
          JSON.stringify({
            id: '9bc2f8e0-9b2f-4d14-ae5f-d8c7a0956d3f',
            email: 'owner@example.com',
            role: 'admin',
          }),
          { headers: { 'content-type': 'application/json' } },
        );
      }
      return new Response('', { status: 500 });
    });
    renderResetPage('/account/reset?token=reset-token');

    expect(await screen.findByText('Dashboard destination')).toBeVisible();
  });
});
