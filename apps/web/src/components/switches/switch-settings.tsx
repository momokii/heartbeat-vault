import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { z } from 'zod';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { FieldGuidance } from '@/components/ui/field-guidance';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { apiClient } from '@/lib/api-client';

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
    } catch {
      setMessage('Settings could not be saved. Try again.');
    } finally {
      setBusy(false);
    }
  }
  async function remove(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const confirmation = new FormData(event.currentTarget).get('confirmation');
    if (confirmation !== item.title) {
      setMessage('Type the exact switch name to confirm deletion.');
      return;
    }
    setMessage(null);
    setConfirmingDelete(true);
  }
  async function confirmRemove(): Promise<void> {
    setConfirmingDelete(false);
    setBusy(true);
    setMessage(null);
    try {
      await apiClient.request({
        method: 'DELETE',
        path: `/switches/${item.id}`,
        schema: deletedSchema,
      });
      navigate('/');
    } catch {
      setMessage('This switch could not be deleted. Released switches are immutable.');
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
                disabled={busy || item.status === 'released'}
              />
              <FieldGuidance
                field="deleting this switch"
                description="Deletion is permanent and requires this exact title. Released switches cannot be deleted."
                example={`Type “${item.title}” exactly.`}
              />
            </div>
            <Button
              type="submit"
              variant="destructive"
              disabled={busy || item.status === 'released'}
            >
              Delete switch
            </Button>
            {confirmingDelete ? (
              <div
                role="alertdialog"
                aria-label={`Confirm deletion of ${item.title}`}
                className="space-y-2 rounded-md border border-[var(--color-destructive)] p-3"
              >
                <p className="text-sm font-medium">
                  Permanently delete “{item.title}”? This cannot be undone.
                </p>
                <div className="flex gap-2">
                  <Button
                    type="button"
                    variant="destructive"
                    disabled={busy}
                    onClick={() => void confirmRemove()}
                  >
                    {busy ? 'Deleting…' : 'Yes, delete it'}
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => setConfirmingDelete(false)}
                  >
                    Cancel
                  </Button>
                </div>
              </div>
            ) : null}
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
