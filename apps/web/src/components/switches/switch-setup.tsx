import { PayloadSetup } from './payload-setup';
import { RecipientSetup } from './recipient-setup';

export function SwitchSetup({
  switchId,
  disabled,
}: {
  readonly switchId: string;
  readonly disabled: boolean;
}) {
  return (
    <div className="space-y-6">
      <RecipientSetup switchId={switchId} disabled={disabled} />
      <PayloadSetup switchId={switchId} disabled={disabled} />
    </div>
  );
}
