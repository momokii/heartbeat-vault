import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ExportDialog } from './export-dialog';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function renderDialog(): {
  readonly onClose: ReturnType<typeof vi.fn>;
  readonly onExported: ReturnType<typeof vi.fn>;
} {
  const onClose = vi.fn();
  const onExported = vi.fn();
  render(<ExportDialog onClose={onClose} onExported={onExported} />);
  return { onClose, onExported };
}

describe('ExportDialog', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('fills the date range from the Today shortcut', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse([]));

    renderDialog();

    fireEvent.click(screen.getByRole('button', { name: 'Today' }));
    const now = new Date();
    const pad = (value: number): string => String(value).padStart(2, '0');
    const day = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
    expect(screen.getByLabelText('From')).toHaveValue(`${day}T00:00`);
    expect(screen.getByLabelText('To')).toHaveValue(`${day}T23:59`);
  });

  it('requires a switch when exporting a switch report', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse([]));

    renderDialog();

    fireEvent.change(screen.getByLabelText('Report scope'), { target: { value: 'switch' } });
    fireEvent.click(screen.getByRole('button', { name: 'Export' }));

    expect(await screen.findByText('Choose a switch to export.')).toBeVisible();
  });

  it('submits the configured export and closes on success', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(jsonResponse([]))
      .mockResolvedValueOnce(
        new Response('{}', { headers: { 'content-type': 'application/json' } }),
      );
    vi.stubGlobal('URL', {
      createObjectURL: vi.fn(() => 'blob:dialog-export'),
      revokeObjectURL: vi.fn(),
    });
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);

    const { onClose, onExported } = renderDialog();

    fireEvent.change(screen.getByLabelText('Output format'), { target: { value: 'json' } });
    fireEvent.click(screen.getByRole('button', { name: 'Export' }));

    await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
    expect(onExported).toHaveBeenCalledOnce();
    const switchCall = fetchMock.mock.calls[0]!;
    expect(switchCall[0]).toBe('/api/switches?all=1');
    const exportCall = fetchMock.mock.calls[1]!;
    expect(exportCall[0]).toBe('/api/reports/exports');
    expect(exportCall[1]).toMatchObject({ method: 'POST', credentials: 'include' });
    expect(JSON.parse(String(exportCall[1]?.body ?? '{}'))).toEqual({
      format: 'json',
      scope: 'global',
    });
  });

  it('shows the size error returned by the API', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(jsonResponse([]))
      .mockResolvedValueOnce(jsonResponse({ error: 'export_limit_exceeded' }, 400));

    renderDialog();

    fireEvent.click(screen.getByRole('button', { name: 'Export' }));

    expect(
      await screen.findByText(
        'This export is too large. Narrow the date range or pick a category.',
      ),
    ).toBeVisible();
  });

  it('lists available switches with owner emails in the switch picker', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse([
        {
          id: '22222222-2222-4222-8222-222222222222',
          title: 'legacy-plan',
          ownerEmail: 'owner@example.test',
        },
      ]),
    );

    renderDialog();

    fireEvent.change(screen.getByLabelText('Report scope'), { target: { value: 'switch' } });
    expect(await screen.findByText('legacy-plan — owner@example.test')).toBeVisible();
  });
});
