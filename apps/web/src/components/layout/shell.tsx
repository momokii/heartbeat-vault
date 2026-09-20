import { Outlet } from 'react-router-dom';
import { Header } from './header';

export function Shell() {
  return (
    <div className="min-h-[100dvh] flex flex-col">
      <a href="#main-content" className="skip-link">
        Skip to content
      </a>
      <Header />
      <main
        id="main-content"
        tabIndex={-1}
        className="flex-1 mx-auto w-full max-w-6xl px-4 py-8 sm:px-6 sm:py-10"
      >
        <Outlet />
      </main>
      <footer className="border-t py-6">
        <div className="mx-auto max-w-6xl px-4 sm:px-6 flex flex-col sm:flex-row items-center justify-between gap-2 text-sm text-[var(--color-muted-foreground)]">
          <p>© {new Date().getFullYear()} Heartbeat Vault — self-hosted. Your keys, your host.</p>
          <p className="font-mono text-xs">Standard profile · v0.0.0</p>
        </div>
      </footer>
    </div>
  );
}
