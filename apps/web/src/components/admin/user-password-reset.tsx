import { Button } from '@/components/ui/button';

export type PasswordResetResult =
  | { readonly kind: 'idle' }
  | { readonly kind: 'submitting'; readonly userId: string }
  | { readonly kind: 'success'; readonly userId: string; readonly token: string }
  | { readonly kind: 'error'; readonly userId: string; readonly message: string };

type UserPasswordResetProps = {
  readonly userId: string;
  readonly role: string;
  readonly result: PasswordResetResult;
  readonly onCreatePasswordReset: (userId: string) => Promise<void>;
};

export function UserPasswordReset({
  userId,
  role,
  result,
  onCreatePasswordReset,
}: UserPasswordResetProps) {
  const isSubmitting = result.kind === 'submitting' && result.userId === userId;

  return (
    <>
      <div className="flex items-center gap-2">
        <span className="rounded-full border px-2 py-0.5 text-xs">{role}</span>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={isSubmitting}
          onClick={() => void onCreatePasswordReset(userId)}
        >
          {isSubmitting ? 'Creating password reset…' : 'Reset password'}
        </Button>
      </div>
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
