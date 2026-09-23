import { useState } from 'react';
import { Button } from '@/components/ui/button';

export type PasswordResetResult =
  | { readonly kind: 'idle' }
  | { readonly kind: 'submitting'; readonly userId: string }
  | { readonly kind: 'success'; readonly userId: string; readonly token: string }
  | { readonly kind: 'error'; readonly userId: string; readonly message: string };

type UserPasswordResetProps = {
  readonly userId: string;
  readonly email: string;
  readonly role: string;
  readonly isSelf: boolean;
  readonly result: PasswordResetResult;
  readonly onCreatePasswordReset: (userId: string) => Promise<void>;
};

export function UserPasswordReset({
  userId,
  email,
  role,
  isSelf,
  result,
  onCreatePasswordReset,
}: UserPasswordResetProps) {
  const [confirming, setConfirming] = useState(false);
  const isSubmitting = result.kind === 'submitting' && result.userId === userId;

  if (isSelf) {
    return (
      <div className="flex items-center gap-2">
        <span className="rounded-full border px-2 py-0.5 text-xs">{role}</span>
        <span className="text-xs text-[var(--color-muted-foreground)]">
          Use Account to change your own password.
        </span>
      </div>
    );
  }

  return (
    <>
      <div className="flex items-center gap-2">
        <span className="rounded-full border px-2 py-0.5 text-xs">{role}</span>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={isSubmitting}
          onClick={() => setConfirming(true)}
        >
          {isSubmitting ? 'Creating password reset…' : 'Reset password'}
        </Button>
      </div>
      {confirming && result.kind !== 'submitting' ? (
        <div
          role="alertdialog"
          aria-label={`Confirm password reset for ${email}`}
          className="w-full space-y-2 rounded-md border p-3"
        >
          <p className="text-sm">
            Issue a one-time password reset link for {email}? This invalidates any earlier unused
            reset link for this user.
          </p>
          <div className="flex gap-2">
            <Button
              type="button"
              variant="destructive"
              size="sm"
              disabled={isSubmitting}
              onClick={() => {
                setConfirming(false);
                void onCreatePasswordReset(userId);
              }}
            >
              Confirm reset
            </Button>
            <Button type="button" variant="outline" size="sm" onClick={() => setConfirming(false)}>
              Cancel
            </Button>
          </div>
        </div>
      ) : null}
      {result.kind === 'success' && result.userId === userId ? (
        <div className="w-full space-y-2 rounded-md border p-3">
          <p className="break-all font-mono text-xs">
            Password reset token — copy and share securely now: {result.token}
          </p>
          <p className="break-all text-xs text-[var(--color-muted-foreground)]">
            Reset link: {window.location.origin}/account/reset?token=
            {encodeURIComponent(result.token)}
          </p>
          <p className="text-xs text-[var(--color-muted-foreground)]">
            This link is single-use, expires after 24 hours, and must be shared securely.
          </p>
        </div>
      ) : null}
      {result.kind === 'error' && result.userId === userId ? (
        <p role="alert" className="w-full text-sm text-[var(--color-destructive)]">
          {result.message}
        </p>
      ) : null}
    </>
  );
}
