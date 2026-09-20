import { NavLink } from 'react-router-dom';
import { ThemeToggle } from './theme-toggle';

const NAV_ITEMS: readonly { readonly to: string; readonly label: string }[] = [
  { to: '/', label: 'Home' },
  { to: '/login', label: 'Login' },
  { to: '/setup', label: 'Setup' },
] as const;

export function Header() {
  return (
    <header className="sticky top-0 z-40 w-full border-b bg-[var(--color-background)]/80 backdrop-blur supports-[backdrop-filter]:bg-[var(--color-background)]/80">
      <div className="mx-auto flex h-14 max-w-6xl items-center justify-between gap-4 px-4 sm:px-6">
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
            <span className="text-[15px]">Heartbeat Vault</span>
          </NavLink>
          <nav aria-label="Primary" className="hidden sm:flex items-center gap-1">
            {NAV_ITEMS.map(item => (
              <NavLink
                key={item.to}
                to={item.to}
                className={({ isActive }) =>
                  [
                    'rounded-md px-2.5 py-1.5 text-sm font-medium transition-colors',
                    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-ring)]',
                    isActive
                      ? 'bg-[var(--color-accent)] text-[var(--color-foreground)]'
                      : 'text-[var(--color-muted-foreground)] hover:text-[var(--color-foreground)]',
                  ].join(' ')
                }
              >
                {item.label}
              </NavLink>
            ))}
          </nav>
        </div>
        <div className="flex items-center gap-2">
          <nav aria-label="Primary mobile" className="flex sm:hidden items-center gap-1">
            {NAV_ITEMS.map(item => (
              <NavLink
                key={item.to}
                to={item.to}
                className={({ isActive }) =>
                  [
                    'rounded-md px-2 py-1 text-sm',
                    isActive ? 'bg-[var(--color-accent)]' : 'text-[var(--color-muted-foreground)]',
                  ].join(' ')
                }
              >
                {item.label}
              </NavLink>
            ))}
          </nav>
          <ThemeToggle />
        </div>
      </div>
    </header>
  );
}
