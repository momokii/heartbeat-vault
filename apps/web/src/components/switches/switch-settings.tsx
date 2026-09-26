import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { z } from 'zod';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { FieldGuidance } from '@/components/ui/field-guidance';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ApiError, apiClient } from '@/lib/api-client';

const updateSchema = z.object({
  title: z.string().trim().min(1).max(200),
  heartbeatIntervalHours: z.coerce.number().int().min(24).max(2160),
  graceWindowHours: z.coerce.number().int().min(2),
  dryRun: z.boolean(),
});
const responseSchema = z.object({
  id: z.string().uuid(),
  title: z.string(),
  mode: z.string(),
  status: z.string(),
  heartbeatIntervalHours: z.number().int(),
  graceWindowHours: z.number().int(),
  dryRun: z.boolean(),
  releasePolicy: z.string(),
  heartbeatStartedAt: z.string().datetime().nullable(),
  nextDeadline: z.string().datetime().nullable(),
});
const deletedSchema = z.object({ ok: z.literal(true) });
type SwitchSettingsValue = z.infer<typeof responseSchema>;

export function SwitchSettings({
  item,
  onUpdated,
}: {
  readonly item: SwitchSettingsValue;
  readonly onUpdated: (item: SwitchSettingsValue) => void;
}) {
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [confirmation, setConfirmation] = useState('');
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  async function save(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const parsed = updateSchema.safeParse({
      title: form.get('title'),
      heartbeatIntervalHours: form.get('heartbeatIntervalHours'),
      graceWindowHours: form.get('graceWindowHours'),
      dryRun: form.get('dryRun') === 'on',
    });
    if (!parsed.success) {
      setMessage('Check the switch settings and try again.');
      return;
    }
    setBusy(true);
    setMessage(null);
    try {
      const result = await apiClient.request({
        method: 'PATCH',
        path: `/switches/${item.id}`,
        body: parsed.data,
        schema: responseSchema,
      });
      onUpdated(result);
      setMessage('Settings saved.');
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) {
        setMessage('You already have a switch with this title.');
      } else {
        setMessage('Settings could not be saved. Try again.');
      }
    } finally {
      setBusy(false);
    }
  }
  async function remove(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (confirmation !== item.title) {
      setDeleteError('Type the exact switch name to confirm deletion.');
      return;
    }
    setDeleteError(null);
    setConfirmingDelete(true);
  }
  async function confirmRemove(): Promise<void> {
    if (confirmation !== item.title) {
      setConfirmingDelete(false);
      setDeleteError('The typed name no longer matches. Type the exact switch name again.');
      return;
    }
    setConfirmingDelete(false);
    setBusy(true);
    setDeleteError(null);
    try {
      await apiClient.request({
        method: 'DELETE',
        path: `/switches/${item.id}`,
        schema: deletedSchema,
      });
      navigate('/');
    } catch {
      setDeleteError('This switch could not be deleted. Released switches are immutable.');
      setBusy(false);
    }
  }
  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>Settings</CardTitle>
          <CardDescription>Changes take effect for future heartbeat deadlines.</CardDescription>
        </CardHeader>
        <CardContent>
          <form className="space-y-4" onSubmit={save} noValidate>
            <div className="space-y-2">
              <Label htmlFor="edit-title">Name</Label>
              <Input
                id="edit-title"
                name="title"
                defaultValue={item.title}
                disabled={busy || item.status === 'released'}
                required
              />
              <FieldGuidance
                field="the switch name"
                description="This 1–200-character label identifies the switch in your dashboard."
                example="Family recovery plan"
              />
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="edit-interval">Heartbeat interval (hours)</Label>
                <Input
                  id="edit-interval"
                  name="heartbeatIntervalHours"
                  type="number"
                  min="24"
                  max="2160"
                  defaultValue={item.heartbeatIntervalHours}
                  disabled={busy || item.status === 'released'}
                  required
                />
                <FieldGuidance
                  field="the heartbeat interval"
                  description="Choose 24–2160 hours between expected check-ins."
                  example="168 hours (7 days)"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="edit-grace">Grace window (hours)</Label>
                <Input
                  id="edit-grace"
                  name="graceWindowHours"
                  type="number"
                  min="2"
                  defaultValue={item.graceWindowHours}
                  disabled={busy || item.status === 'released'}
                  required
                />
                <FieldGuidance
                  field="the grace window"
                  description="Choose at least 2 hours for the period after a missed deadline when the owner can still check in."
                  example="24 hours (1 day)"
                />
              </div>
            </div>
            <label className="flex gap-2 text-sm">
              <input
                type="checkbox"
                name="dryRun"
                defaultChecked={item.dryRun}
                disabled={busy || item.status === 'released'}
              />{' '}
              Test deliveries without releasing a payload
            </label>
            <FieldGuidance
              field="a dry run"
              description="Dry run marks deliveries as tests and never releases a real payload."
              example="Enable it while reviewing a new delivery channel."
            />
            {message ? (
              <p role="status" className="text-sm text-[var(--color-muted-foreground)]">
                {message}
              </p>
            ) : null}
            <FieldGuidance
              field="saving these settings"
              description="This action patches the name, interval, grace window, and dry-run choice together."
              example="Save a 168-hour interval and a 24-hour grace window."
            />
            <Button type="submit" disabled={busy || item.status === 'released'}>
              {busy ? 'Saving…' : 'Save settings'}
            </Button>
          </form>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Delete switch</CardTitle>
          <CardDescription>
            Deletion is permanent. Released switches cannot be deleted.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form className="space-y-4" onSubmit={remove} noValidate>
            <div className="space-y-2">
              <Label htmlFor="delete-confirmation">Type “{item.title}” to delete</Label>
              <Input
                id="delete-confirmation"
                name="confirmation"
                value={confirmation}
                onChange={event => {
                  setConfirmation(event.target.value);
                  setConfirmingDelete(false);
                }}
                disabled={busy || item.status === 'released'}
              />
              <FieldGuidance
                field="deleting this switch"
                description="Deletion is permanent and requires this exact title. Released switches cannot be deleted."
                example={`Type “${item.title}” exactly.`}
              />
            </div>
            {deleteError ? (
              <p role="alert" className="text-sm text-[var(--color-destructive)]">
                {deleteError}
              </p>
            ) : null}
            <Button
              type="submit"
              variant="destructive"
              disabled={busy || item.status === 'released'}
            >
              Delete switch
            </Button>
          </form>
          {confirmingDelete ? (
            <div
              className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
              onClick={() => setConfirmingDelete(false)}
            >
              <div
                role="alertdialog"
                aria-modal="true"
                aria-label={`Confirm deletion of ${item.title}`}
                onClick={event => event.stopPropagation()}
                onKeyDown={event => {
                  if (event.key === 'Escape') setConfirmingDelete(false);
                }}
                className="w-full max-w-md space-y-3 rounded-lg border border-[var(--color-destructive)] bg-[var(--color-background)] p-5"
              >
                <p className="text-base font-semibold">
                  Permanently delete “{item.title}”? This cannot be undone.
                </p>
                <p className="text-sm text-[var(--color-muted-foreground)]">
                  Its recipients, sealed payload, and history are removed with it.
                </p>
                <div className="flex justify-end gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    autoFocus
                    onClick={() => setConfirmingDelete(false)}
                  >
                    Cancel
                  </Button>
                  <Button
                    type="button"
                    variant="destructive"
                    disabled={busy}
                    onClick={() => void confirmRemove()}
                  >
                    {busy ? 'Deleting…' : 'Yes, delete it'}
                  </Button>
                </div>
              </div>
            </div>
          ) : null}
        </CardContent>
      </Card>
    </div>
  );
}
