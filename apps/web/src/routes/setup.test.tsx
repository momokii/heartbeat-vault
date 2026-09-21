import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { AuthProvider } from '@/lib/auth';
import { SetupPage } from './setup';

describe('SetupPage', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('retains the completed-setup state when the setup probe returns 410', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async input => {
      if (input === '/api/me') return new Response('', { status: 401 });
      if (input === '/api/setup') return new Response('', { status: 410 });
      return new Response('', { status: 500 });
    });

    render(
      <MemoryRouter initialEntries={['/setup']}>
        <AuthProvider>
          <Routes>
            <Route path="/setup" element={<SetupPage />} />
          </Routes>
        </AuthProvider>
      </MemoryRouter>,
    );

    expect(await screen.findByText('This vault is already configured.')).toBeVisible();
  });

  it('redirects an authenticated visitor away from setup', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async input => {
      if (input === '/api/me') {
        return new Response(
          JSON.stringify({
            id: '9bc2f8e0-9b2f-4d14-ae5f-d8c7a0956d3f',
            email: 'owner@example.com',
            role: 'admin',
          }),
          { headers: { 'content-type': 'application/json' } },
        );
      }
      if (input === '/api/setup') return new Response('', { status: 410 });
      return new Response('', { status: 500 });
    });

    render(
      <MemoryRouter initialEntries={['/setup']}>
        <AuthProvider>
          <Routes>
            <Route path="/" element={<p>Dashboard destination</p>} />
            <Route path="/setup" element={<SetupPage />} />
          </Routes>
        </AuthProvider>
      </MemoryRouter>,
    );

    expect(await screen.findByText('Dashboard destination')).toBeVisible();
  });
});
