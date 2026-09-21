import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { AuthProvider } from '@/lib/auth';
import { InviteAcceptPage } from './invite-accept';

const signedOutFetch = (consume: (input: unknown) => Promise<Response>) =>
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, _init) => {
    if (typeof input === 'string' && input === '/api/me') return new Response('', { status: 401 });
    return consume(input);
  });

describe('InviteAcceptPage', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('prefills the token from the query string and creates the account', async () => {
    const fetchMock = signedOutFetch(async input => {
      if (typeof input === 'string' && input.includes('/invites/consume')) {
        return new Response(JSON.stringify({ id: 'user-id', email: 'a@b.com', role: 'user' }), {
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response('', { status: 500 });
    });

    render(
      <MemoryRouter initialEntries={['/invite/accept?token=tok123']}>
        <AuthProvider>
          <Routes>
            <Route path="/invite/accept" element={<InviteAcceptPage />} />
          </Routes>
        </AuthProvider>
      </MemoryRouter>,
    );

    expect(((await screen.findByLabelText('Invitation token')) as HTMLInputElement).value).toBe(
      'tok123',
    );
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'a@b.com' } });
    fireEvent.change(screen.getByLabelText('Password'), {
      target: { value: 'longenoughpassword123' },
    });
    fireEvent.change(screen.getByLabelText('Confirm password'), {
      target: { value: 'longenoughpassword123' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Create account' }));

    expect(await screen.findByText('Your account is ready.')).toBeVisible();
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/invites/consume',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          token: 'tok123',
          email: 'a@b.com',
          password: 'longenoughpassword123',
        }),
        credentials: 'include',
      }),
    );
  });

  it('shows a validation error when passwords do not match', async () => {
    const fetchMock = signedOutFetch(async () => new Response('', { status: 500 }));
    render(
      <MemoryRouter initialEntries={['/invite/accept']}>
        <AuthProvider>
          <Routes>
            <Route path="/invite/accept" element={<InviteAcceptPage />} />
          </Routes>
        </AuthProvider>
      </MemoryRouter>,
    );

    fireEvent.change(await screen.findByLabelText('Invitation token'), {
      target: { value: 'tok' },
    });
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'a@b.com' } });
    fireEvent.change(screen.getByLabelText('Password'), {
      target: { value: 'longenoughpassword123' },
    });
    fireEvent.change(screen.getByLabelText('Confirm password'), { target: { value: 'different' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create account' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Passwords do not match.');
    expect(fetchMock).not.toHaveBeenCalledWith(
      '/api/invites/consume',
      expect.objectContaining({ method: 'POST' }),
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

    render(
      <MemoryRouter initialEntries={['/invite/accept?token=tok123']}>
        <AuthProvider>
          <Routes>
            <Route path="/" element={<p>Dashboard destination</p>} />
            <Route path="/invite/accept" element={<InviteAcceptPage />} />
          </Routes>
        </AuthProvider>
      </MemoryRouter>,
    );

    expect(await screen.findByText('Dashboard destination')).toBeVisible();
  });
});
