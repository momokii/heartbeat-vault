import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { NewSwitchPage } from './switch-new';
import { calculatePreviewSchedule } from './switch-new-guidance';

function renderPage(): void {
  render(
    <MemoryRouter initialEntries={['/switches/new']}>
      <Routes>
        <Route path="/switches/new" element={<NewSwitchPage />} />
        <Route path="/" element={<p>Dashboard destination</p>} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('NewSwitchPage', () => {
  it('computes the missed deadline and release time from the interval and grace window', () => {
    const schedule = calculatePreviewSchedule({
      now: new Date('2026-01-02T03:04:05.000Z'),
      heartbeatIntervalHours: 48,
      graceWindowHours: 6,
    });

    expect(schedule.nextDeadline.toISOString()).toBe('2026-01-04T03:04:05.000Z');
    expect(schedule.releaseAt.toISOString()).toBe('2026-01-04T09:04:05.000Z');
  });

  it('fills the guided form with a sensible dry-run example', () => {
    renderPage();

    fireEvent.click(screen.getByRole('button', { name: 'Fill with example values' }));

    expect(screen.getByLabelText('Name')).toHaveValue('Family recovery plan');
    expect(
      screen.getByRole('radio', { name: /Deliver the sealed message directly/ }),
    ).toBeChecked();
    expect(screen.getByLabelText('Heartbeat interval (hours)')).toHaveValue(168);
    expect(screen.getByLabelText('Grace window (hours)')).toHaveValue(24);
    expect(screen.getByRole('radio', { name: /Fail safe/ })).toBeChecked();
    expect(screen.getByLabelText('Run a delivery test')).toBeChecked();
  });

  it('resets the guided form back to its defaults', () => {
    renderPage();

    fireEvent.click(screen.getByRole('button', { name: 'Fill with example values' }));
    expect(screen.getByLabelText('Name')).toHaveValue('Family recovery plan');

    fireEvent.click(screen.getByRole('button', { name: 'Reset all values' }));

    expect(screen.getByLabelText('Name')).toHaveValue('');
    expect(screen.getByRole('radio', { name: /Release an encryption key/ })).toBeChecked();
    expect(screen.getByLabelText('Heartbeat interval (hours)')).toHaveValue(168);
    expect(screen.getByLabelText('Grace window (hours)')).toHaveValue(24);
    expect(screen.getByRole('radio', { name: /Fail safe/ })).toBeChecked();
    expect(screen.getByLabelText('Run a delivery test')).not.toBeChecked();
  });

  it('toggles each field explanation from its accessible help button', () => {
    renderPage();

    const help = screen.getByRole('button', { name: 'What is this name?' });
    expect(help).toHaveAttribute('aria-expanded', 'false');

    fireEvent.click(help);

    expect(help).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('region', { name: 'this name explanation' })).toHaveTextContent(
      'Name must be 1–200 characters.',
    );
  });

  it('updates the release outcome from the selected cadence, mode, policy, and dry run', () => {
    renderPage();

    fireEvent.change(screen.getByLabelText('Heartbeat interval (hours)'), {
      target: { value: '48' },
    });
    fireEvent.change(screen.getByLabelText('Grace window (hours)'), { target: { value: '6' } });
    fireEvent.click(screen.getByRole('radio', { name: /Deliver the sealed message directly/ }));
    fireEvent.click(screen.getByRole('radio', { name: /Fail deadly/ }));
    fireEvent.click(screen.getByLabelText('Run a delivery test'));

    const preview = within(screen.getByRole('region', { name: 'What happens next' }));
    expect(preview.getByText(/check in every 48 hours/i)).toBeVisible();
    expect(preview.getByText(/6-hour grace window/i)).toBeVisible();
    expect(preview.getByText(/sealed message is delivered directly/i)).toBeVisible();
    expect(preview.getByText(/releases even when the service is uncertain/i)).toBeVisible();
    expect(preview.getByText(/test deliveries are marked as tests/i)).toBeVisible();
  });

  it('keeps the existing Zod validation messages', () => {
    renderPage();

    const form = screen.getByRole('button', { name: 'Create paused switch' }).closest('form');
    if (!(form instanceof HTMLFormElement)) throw new Error('Expected the creation form.');

    fireEvent.submit(form);
    expect(screen.getByRole('alert')).toHaveTextContent('Give this switch a name.');

    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Recovery plan' } });
    fireEvent.change(screen.getByLabelText('Heartbeat interval (hours)'), {
      target: { value: '12' },
    });
    fireEvent.submit(form);
    expect(screen.getByRole('alert')).toHaveTextContent('Use at least a 24-hour interval.');
  });
});
