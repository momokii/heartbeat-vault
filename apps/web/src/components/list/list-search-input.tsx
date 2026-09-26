import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

type ListSearchInputProps = {
  readonly id: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly placeholder: string;
};

/** Shared search box styling for every list in the app. */
export function ListSearchInput({ id, value, onChange, placeholder }: ListSearchInputProps) {
  return (
    <div className="space-y-2">
      <Label htmlFor={id}>Search</Label>
      <Input
        id={id}
        type="search"
        value={value}
        onChange={event => onChange(event.currentTarget.value)}
        placeholder={placeholder}
      />
    </div>
  );
}
