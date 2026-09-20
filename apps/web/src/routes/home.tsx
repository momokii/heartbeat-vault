import { Link } from 'react-router-dom';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

export function HomePage() {
  return (
    <div className="space-y-8">
      <section className="space-y-4 max-w-3xl">
        <p className="text-xs font-mono uppercase tracking-[0.18em] text-[var(--color-muted-foreground)]">
          Dead man&apos;s switch — self-hosted
        </p>
        <h1 className="text-3xl sm:text-4xl font-semibold tracking-tight leading-[1.1]">
          Your heartbeat keeps the vault sealed.
        </h1>
        <p className="text-base leading-relaxed text-[var(--color-muted-foreground)] max-w-[65ch]">
          Heartbeat Vault holds encrypted payloads until a trigger fires — missed check-in, fixed
          date, or panic. Self-hosted on your hardware, no third-party custody. This shell is a
          placeholder; feature pages land in T7.2–T7.5.
        </p>
        <div className="flex flex-wrap gap-3 pt-2">
          <Link
            to="/setup"
            className="inline-flex h-9 items-center justify-center rounded-md bg-[var(--color-primary)] px-4 text-sm font-medium text-[var(--color-primary-foreground)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-ring)]"
          >
            Start setup
          </Link>
          <Link
            to="/login"
            className="inline-flex h-9 items-center justify-center rounded-md border px-4 text-sm font-medium hover:bg-[var(--color-accent)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-ring)]"
          >
            Sign in
          </Link>
        </div>
      </section>

      <section aria-labelledby="shell-status" className="grid gap-4 sm:grid-cols-3">
        <h2 id="shell-status" className="sr-only">
          Shell status
        </h2>
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Shell</CardTitle>
            <CardDescription>Layout + theme + routing ready</CardDescription>
          </CardHeader>
          <CardContent className="text-sm text-[var(--color-muted-foreground)]">
            Header, nav, main, footer landmarks verified. Class-based dark/light toggle persisted.
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">API stub</CardTitle>
            <CardDescription>Typed fetch + Zod placeholder</CardDescription>
          </CardHeader>
          <CardContent className="text-sm text-[var(--color-muted-foreground)]">
            <code className="font-mono text-xs">src/lib/api-client.ts</code> — base URL from{' '}
            <code className="font-mono text-xs">VITE_API_BASE_URL</code>.
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Accessibility</CardTitle>
            <CardDescription>WCAG AA baseline</CardDescription>
          </CardHeader>
          <CardContent className="text-sm text-[var(--color-muted-foreground)]">
            Skip link, focus-visible rings, semantic landmarks, labels, and responsive layout.
          </CardContent>
        </Card>
      </section>
    </div>
  );
}
