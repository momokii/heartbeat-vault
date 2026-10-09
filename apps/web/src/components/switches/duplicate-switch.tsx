import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { z } from 'zod';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ApiError, apiClient } from '@/lib/api-client';

const duplicateResponseSchema = z.object({
  id: z.string().uuid(),
  status: z.string(),
  dryRun: z.boolean(),
});

function errorMessage(error: unknown): string {
  if (error instanceof ApiError && error.status === 409) {
    return 'A switch with that title already exists.';
  }
  if (error instanceof ApiError && error.status === 404) {
    return 'That switch no longer exists.';
  }
  if (error instanceof ApiError && error.status === 400) {
    return 'Enter a valid title (1–200 characters).';
  }
  return 'The switch could not be duplicated. Try again.';
}

export function DuplicateSwitch({
  switchId,
  switchTitle,
}: {
  readonly switchId: string;
  readonly switchTitle: string;
}) {
  const navigate = useNavigate();
  const [title, setTitle] = useState(`${switchTitle} copy`);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setMessage(null);
    setBusy(true);
    try {
      const result = await apiClient.request({
        method: 'POST',
        path: `/switches/${switchId}/duplicate`,
        body: { title: title.trim() },
        schema: duplicateResponseSchema,
      });
      navigate(`/switches/${result.id}`);
    } catch (error) {
      setMessage(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Duplicate switch</CardTitle>
        <CardDescription>
          Copy this switch&apos;s configuration into a new paused switch. Payload, recipients,
          tokens, and history are never copied.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form className="space-y-4" onSubmit={event => void submit(event)} noValidate>
          <div className="space-y-2">
            <Label htmlFor="duplicate-title">New switch title</Label>
            <Input
              id="duplicate-title"
              value={title}
              onChange={event => setTitle(event.currentTarget.value)}
              disabled={busy}
              maxLength={200}
              required
            />
          </div>
          {message !== null ? (
            <p role="status" className="text-sm text-[var(--color-muted-foreground)]">
              {message}
            </p>
          ) : null}
          <Button type="submit" variant="outline" disabled={busy}>
            {busy ? 'Duplicating…' : 'Duplicate switch'}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
