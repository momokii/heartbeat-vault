import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { AuthProvider } from '@/lib/auth';
import { AccountPage } from './account';

const authenticatedUser = {
  id: '9bc2f8e0-9b2f-4d14-ae5f-d8c7a0956d3f',
  email: 'owner@example.com',
  role: 'admin',
};

describe('AccountPage', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('shows the current user and account controls for an authenticated visitor', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify(authenticatedUser), {
        headers: { 'content-type': 'application/json' },
      }),
    );

    render(
      <MemoryRouter initialEntries={['/account']}>
        <AuthProvider>
          <Routes>
            <Route path="/account" element={<AccountPage />} />
          </Routes>
        </AuthProvider>
      </MemoryRouter>,
    );

    expect(await screen.findByRole('heading', { name: 'Account' })).toBeVisible();
    expect(screen.getByText('owner@example.com')).toBeVisible();
    expect(screen.getByLabelText('Current password')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Change password' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Logout' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Revoke all sessions' })).toBeVisible();
  });

  it('submits a verified password change through the account endpoint', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async input => {
      if (input === '/api/me') {
        return new Response(JSON.stringify(authenticatedUser), {
          headers: { 'content-type': 'application/json' },
        });
      }
      if (input === '/api/account/password') {
        return new Response(JSON.stringify({ ok: true }), {
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response('', { status: 500 });
    });

    render(
      <MemoryRouter initialEntries={['/account']}>
        <AuthProvider>
          <Routes>
            <Route path="/account" element={<AccountPage />} />
          </Routes>
        </AuthProvider>
      </MemoryRouter>,
    );

    await screen.findByRole('heading', { name: 'Account' });
    fireEvent.change(screen.getByLabelText('Current password'), {
      target: { value: 'current-password-123' },
    });
    fireEvent.change(screen.getByLabelText('New password'), {
      target: { value: 'replacement-password-123' },
    });
    fireEvent.change(screen.getByLabelText('Confirm new password'), {
      target: { value: 'replacement-password-123' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Change password' }));

    expect(await screen.findByText('Password updated.')).toBeVisible();
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/account/password',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          currentPassword: 'current-password-123',
          newPassword: 'replacement-password-123',
        }),
        credentials: 'include',
      }),
    );
  });

  it('redirects a signed-out visitor to login', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('', { status: 401 }));

    render(
      <MemoryRouter initialEntries={['/account']}>
        <AuthProvider>
          <Routes>
            <Route path="/login" element={<p>Login destination</p>} />
            <Route path="/account" element={<AccountPage />} />
          </Routes>
        </AuthProvider>
      </MemoryRouter>,
    );

    expect(await screen.findByText('Login destination')).toBeVisible();
  });
});
