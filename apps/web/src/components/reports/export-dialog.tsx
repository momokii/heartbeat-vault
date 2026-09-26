import { useEffect, useState, type FormEvent } from 'react';
import { AuditFilterFields } from '@/components/audit/audit-filter-fields';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { ApiError, apiClient } from '@/lib/api-client';
import { EMPTY_AUDIT_FILTERS, type AuditFilterValues } from '@/lib/audit-contract';
import {
  REPORT_DATE_SHORTCUTS,
  REPORT_DATE_SHORTCUT_LABELS,
  applyReportDateShortcut,
  buildExportRequest,
  switchOptionSchema,
  type ReportFormat,
  type ReportScope,
  type SwitchOption,
} from '@/lib/reports-contract';

type ExportDialogProps = {
  readonly onClose: () => void;
  readonly onExported?: () => void;
};

function downloadBlob(blob: Blob, filename: string): void {
  const objectUrl = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = objectUrl;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(objectUrl);
}

export function ExportDialog({ onClose, onExported }: ExportDialogProps) {
  const [scope, setScope] = useState<ReportScope>('global');
  const [switchId, setSwitchId] = useState('');
  const [format, setFormat] = useState<ReportFormat>('csv');
  const [filters, setFilters] = useState<AuditFilterValues>(EMPTY_AUDIT_FILTERS);
  const [switches, setSwitches] = useState<readonly SwitchOption[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    apiClient
      .request({
        path: '/switches',
        query: { all: 1 },
        schema: switchOptionSchema.array(),
        signal: controller.signal,
      })
      .then(rows => setSwitches([...rows].sort((a, b) => a.title.localeCompare(b.title))))
      .catch(() => setSwitches([]));
    return () => controller.abort();
  }, []);

  function applyShortcut(shortcut: keyof typeof REPORT_DATE_SHORTCUT_LABELS): void {
    const range = applyReportDateShortcut(shortcut);
    setFilters(current => ({ ...current, from: range.from, to: range.to }));
  }

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setError(null);
    const request = buildExportRequest({
      format,
      scope,
      switchId,
      category: filters.category,
      from: filters.from,
      to: filters.to,
    });
    if (!request.ok) {
      setError(
        request.error === 'missing_switch'
          ? 'Choose a switch to export.'
          : 'Enter a valid date range.',
      );
      return;
    }
    setBusy(true);
    try {
      const blob = await apiClient.download({
        method: 'POST',
        path: '/reports/exports',
        body: request.body,
        timeoutMs: 60_000,
      });
      const baseName = scope === 'switch' ? 'switch-audit' : 'audit-log';
      downloadBlob(blob, `${baseName}.${format}`);
      onExported?.();
      onClose();
    } catch (err) {
      if (err instanceof ApiError && err.status === 400) {
        setError('This export is too large. Narrow the date range or pick a category.');
      } else if (err instanceof ApiError && err.status === 404) {
        setError('That switch no longer exists. Pick another one.');
      } else {
        setError('The export could not be created. Try again.');
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      role="presentation"
      onClick={event => {
        if (event.target === event.currentTarget && !busy) onClose();
      }}
    >
      <Card className="max-h-[90vh] w-full max-w-lg overflow-y-auto">
        <CardHeader>
          <CardTitle>Export report</CardTitle>
          <CardDescription>
            Choose what to export. Every export is recorded on the reports page.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form className="space-y-4" onSubmit={event => void submit(event)} noValidate>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="export-scope">Report scope</Label>
                <Select
                  id="export-scope"
                  value={scope}
                  onChange={event => setScope(event.currentTarget.value as ReportScope)}
                >
                  <option value="global">Whole audit log</option>
                  <option value="switch">Specific switch</option>
                </Select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="export-format">Output format</Label>
                <Select
                  id="export-format"
                  value={format}
                  onChange={event => setFormat(event.currentTarget.value as ReportFormat)}
                >
                  <option value="csv">CSV (spreadsheet)</option>
                  <option value="json">JSON (structured)</option>
                </Select>
              </div>
            </div>
            {scope === 'switch' ? (
              <div className="space-y-2">
                <Label htmlFor="export-switch">Switch</Label>
                <Select
                  id="export-switch"
                  value={switchId}
                  onChange={event => setSwitchId(event.currentTarget.value)}
                >
                  <option value="">
                    {switches.length === 0 ? 'No switches available' : 'Choose a switch…'}
                  </option>
                  {switches.map(option => (
                    <option key={option.id} value={option.id}>
                      {option.title}
                      {option.ownerEmail ? ` — ${option.ownerEmail}` : ''}
                    </option>
                  ))}
                </Select>
              </div>
            ) : null}
            <div className="space-y-2">
              <Label>Date range</Label>
              <div className="flex flex-wrap gap-2">
                {REPORT_DATE_SHORTCUTS.map(shortcut => (
                  <Button
                    key={shortcut}
                    type="button"
                    variant="outline"
                    className="h-8 px-3 text-xs"
                    onClick={() => applyShortcut(shortcut)}
                  >
                    {REPORT_DATE_SHORTCUT_LABELS[shortcut]}
                  </Button>
                ))}
              </div>
            </div>
            <AuditFilterFields idPrefix="export" filters={filters} onChange={setFilters} />
            {error !== null ? (
              <p role="alert" className="text-sm text-[var(--color-muted-foreground)]">
                {error}
              </p>
            ) : null}
            <div className="flex flex-wrap gap-3">
              <Button type="submit" disabled={busy}>
                {busy ? 'Preparing export…' : 'Export'}
              </Button>
              <Button type="button" variant="outline" disabled={busy} onClick={onClose}>
                Cancel
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
