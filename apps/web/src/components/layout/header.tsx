import { useState } from 'react';
import { NavLink } from 'react-router-dom';
import { z } from 'zod';
import { useAuth } from '@/lib/auth';
import { ApiError, apiClient } from '@/lib/api-client';
import { ThemeToggle } from './theme-toggle';

type NavigationItem = {
  readonly to: string;
  readonly label: string;
};
type HeaderNavigation = {
  readonly items: readonly NavigationItem[];
  readonly logout: (() => void) | null;
  readonly isLoggingOut: boolean;
};
type LogoutState =
  { readonly kind: 'idle' } | { readonly kind: 'submitting' } | { readonly kind: 'error' };

const HOME_NAVIGATION: readonly NavigationItem[] = [{ to: '/', label: 'Home' }] as const;
const PUBLIC_NAVIGATION: readonly NavigationItem[] = [
  { to: '/', label: 'Home' },
  { to: '/login', label: 'Login' },
  { to: '/setup', label: 'Setup' },
  { to: '/invite/accept', label: 'Accept invite' },
] as const;
const AUTHENTICATED_NAVIGATION: readonly NavigationItem[] = [
  { to: '/', label: 'Home' },
  { to: '/admin', label: 'Admin' },
  { to: '/account', label: 'Account' },
] as const;
const OkResponseSchema = z.object({ ok: z.literal(true) });

function Navigation({
  navigation,
  compact,
  label,
}: {
  readonly navigation: HeaderNavigation;
  readonly compact: boolean;
  readonly label: string;
}) {
  const linkClass = (isActive: boolean): string =>
    [
      'rounded-md text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-ring)]',
      compact ? 'px-1 py-1' : 'px-2.5 py-1.5',
      isActive
        ? 'bg-[var(--color-accent)] text-[var(--color-foreground)]'
        : 'text-[var(--color-muted-foreground)] hover:text-[var(--color-foreground)]',
    ].join(' ');

  return (
    <nav
      aria-label={label}
      className={compact ? 'flex items-center gap-0' : 'flex items-center gap-1'}
    >
      {navigation.items.map(item => (
        <NavLink key={item.to} to={item.to} className={({ isActive }) => linkClass(isActive)}>
          {item.label}
        </NavLink>
      ))}
      {navigation.logout ? (
        <button
          type="button"
          className={linkClass(false)}
          disabled={navigation.isLoggingOut}
          onClick={navigation.logout}
        >
          {navigation.isLoggingOut ? 'Logging out…' : 'Logout'}
        </button>
      ) : null}
    </nav>
  );
}

export function Header() {
  const auth = useAuth();
  const [logoutState, setLogoutState] = useState<LogoutState>({ kind: 'idle' });
  const isAuthenticated = auth.kind === 'authenticated';
  const items = isAuthenticated
    ? AUTHENTICATED_NAVIGATION
    : auth.kind === 'unauthenticated'
      ? PUBLIC_NAVIGATION
      : HOME_NAVIGATION;

  async function logout(): Promise<void> {
    setLogoutState({ kind: 'submitting' });
    try {
      await apiClient.request({ method: 'POST', path: '/logout', schema: OkResponseSchema });
      window.location.assign('/');
    } catch (error) {
      if (error instanceof ApiError) {
        setLogoutState({ kind: 'error' });
        return;
      }
      throw error;
    }
  }

  const navigation: HeaderNavigation = {
    items,
    logout: isAuthenticated ? () => void logout() : null,
    isLoggingOut: logoutState.kind === 'submitting',
  };

  return (
    <header className="sticky top-0 z-40 w-full border-b bg-[var(--color-background)]/80 backdrop-blur supports-[backdrop-filter]:bg-[var(--color-background)]/80">
      <div className="mx-auto flex h-14 max-w-6xl items-center justify-between gap-1 px-2 sm:gap-4 sm:px-6">
        <div className="flex items-center gap-6">
          <NavLink
            to="/"
            className="flex items-center gap-2 font-semibold tracking-tight focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-ring)] rounded-sm"
          >
            <span
              aria-hidden="true"
              className="inline-flex h-7 w-7 items-center justify-center rounded-md bg-[var(--color-primary)] text-[var(--color-primary-foreground)] text-[11px] font-bold tracking-widest"
            >
              HV
            </span>
            <span className="sr-only text-[15px] sm:not-sr-only">Heartbeat Vault</span>
          </NavLink>
          <div className="hidden sm:block">
            <Navigation navigation={navigation} compact={false} label="Primary" />
          </div>
        </div>
        <div className="flex items-center gap-0 sm:gap-2">
          <div className="sm:hidden">
            <Navigation navigation={navigation} compact label="Primary mobile" />
          </div>
          <ThemeToggle />
        </div>
      </div>
      {logoutState.kind === 'error' ? (
        <p
          role="alert"
          className="mx-auto max-w-6xl px-4 pb-2 text-sm text-[var(--color-destructive)] sm:px-6"
        >
          Logout could not be completed. Try again.
        </p>
      ) : null}
    </header>
  );
}
