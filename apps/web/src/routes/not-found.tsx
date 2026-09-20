import { Link } from 'react-router-dom';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

export function NotFoundPage() {
  return (
    <div className="mx-auto max-w-md py-8">
      <Card>
        <CardHeader>
          <CardTitle>404 — Not found</CardTitle>
          <CardDescription>The page you’re looking for doesn’t exist.</CardDescription>
        </CardHeader>
        <CardContent className="flex gap-3">
          <Link
            to="/"
            className="inline-flex h-9 items-center justify-center rounded-md bg-[var(--color-primary)] px-4 text-sm font-medium text-[var(--color-primary-foreground)]"
          >
            Go home
          </Link>
          <Link
            to="/login"
            className="inline-flex h-9 items-center justify-center rounded-md border px-4 text-sm font-medium hover:bg-[var(--color-accent)]"
          >
            Sign in
          </Link>
        </CardContent>
      </Card>
    </div>
  );
}
