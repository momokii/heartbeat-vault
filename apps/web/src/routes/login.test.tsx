import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { AuthProvider } from '@/lib/auth';
import { LoginPage } from './login';

describe('LoginPage', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('redirects an already authenticated visitor to the dashboard', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          id: '9bc2f8e0-9b2f-4d14-ae5f-d8c7a0956d3f',
          email: 'owner@example.com',
          role: 'admin',
        }),
        { headers: { 'content-type': 'application/json' } },
      ),
    );

    render(
      <MemoryRouter initialEntries={['/login']}>
        <AuthProvider>
          <Routes>
            <Route path="/" element={<p>Dashboard destination</p>} />
            <Route path="/login" element={<LoginPage />} />
          </Routes>
        </AuthProvider>
      </MemoryRouter>,
    );

    expect(await screen.findByText('Dashboard destination')).toBeVisible();
  });
});
