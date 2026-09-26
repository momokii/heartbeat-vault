import { render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { AuthProvider } from '@/lib/auth';
import { Header } from './header';

const authenticatedUser = {
  id: '9bc2f8e0-9b2f-4d14-ae5f-d8c7a0956d3f',
  email: 'owner@example.com',
  role: 'admin',
};

describe('Header', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('shows authenticated navigation after the current-user probe succeeds', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify(authenticatedUser), {
        headers: { 'content-type': 'application/json' },
      }),
    );

    render(
      <MemoryRouter>
        <AuthProvider>
          <Header />
        </AuthProvider>
      </MemoryRouter>,
    );

    await screen.findAllByRole('link', { name: 'Admin' });
    expect(screen.getAllByRole('link', { name: 'Home' })).not.toHaveLength(0);
    expect(screen.getAllByRole('link', { name: 'Account' })).not.toHaveLength(0);
    expect(screen.getAllByRole('link', { name: 'Activity' })).not.toHaveLength(0);
    expect(screen.getAllByRole('link', { name: 'Reports' })).not.toHaveLength(0);
    expect(screen.getAllByRole('button', { name: 'Logout' })).not.toHaveLength(0);
    expect(screen.queryAllByRole('link', { name: 'Login' })).toHaveLength(0);
    expect(screen.queryAllByRole('link', { name: 'Setup' })).toHaveLength(0);
  });

  it('hides administrative navigation from non-admin users', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ ...authenticatedUser, role: 'user' }), {
        headers: { 'content-type': 'application/json' },
      }),
    );

    render(
      <MemoryRouter>
        <AuthProvider>
          <Header />
        </AuthProvider>
      </MemoryRouter>,
    );

    await screen.findAllByRole('link', { name: 'Admin' });
    expect(screen.queryAllByRole('link', { name: 'Activity' })).toHaveLength(0);
    expect(screen.queryAllByRole('link', { name: 'Reports' })).toHaveLength(0);
  });

  it('shows public navigation after the current-user probe returns 401', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('', { status: 401 }));

    render(
      <MemoryRouter>
        <AuthProvider>
          <Header />
        </AuthProvider>
      </MemoryRouter>,
    );

    await screen.findAllByRole('link', { name: 'Login' });
    expect(screen.getAllByRole('link', { name: 'Home' })).not.toHaveLength(0);
    expect(screen.getAllByRole('link', { name: 'Setup' })).not.toHaveLength(0);
    expect(screen.getAllByRole('link', { name: 'Accept invite' })).not.toHaveLength(0);
    expect(screen.queryAllByRole('link', { name: 'Admin' })).toHaveLength(0);
    expect(screen.queryAllByRole('link', { name: 'Account' })).toHaveLength(0);
    expect(screen.queryAllByRole('button', { name: 'Logout' })).toHaveLength(0);
  });

  it('uses compact spacing for authenticated mobile navigation', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify(authenticatedUser), {
        headers: { 'content-type': 'application/json' },
      }),
    );

    render(
      <MemoryRouter>
        <AuthProvider>
          <Header />
        </AuthProvider>
      </MemoryRouter>,
    );

    const mobileNavigation = await screen.findByRole('navigation', { name: 'Primary mobile' });
    expect(mobileNavigation).toHaveClass('gap-0');
    expect(within(mobileNavigation).getByRole('link', { name: 'Account' })).toHaveClass('px-1');
  });

  it('keeps the theme switch labelled', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify(authenticatedUser), {
        headers: { 'content-type': 'application/json' },
      }),
    );

    render(
      <MemoryRouter>
        <AuthProvider>
          <Header />
        </AuthProvider>
      </MemoryRouter>,
    );

    const themeSwitch = await screen.findByRole('button', { name: 'Switch to dark theme' });
    const visualLabel = themeSwitch.querySelector('span');
    if (!(visualLabel instanceof HTMLSpanElement))
      throw new Error('Expected a visual theme label.');
    expect(visualLabel).toHaveClass('text-xs', 'font-medium');
  });
});
