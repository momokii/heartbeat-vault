import { useId, useState } from 'react';

type FieldGuidanceProps = {
  readonly field: string;
  readonly description: string;
  readonly example: string;
};

export function FieldGuidance({ field, description, example }: FieldGuidanceProps) {
  const [expanded, setExpanded] = useState(false);
  const descriptionId = useId();

  return (
    <div className="space-y-1 text-xs text-[var(--color-muted-foreground)]">
      <button
        type="button"
        title={`Show guidance for ${field}`}
        aria-expanded={expanded}
        aria-controls={descriptionId}
        onClick={() => setExpanded(current => !current)}
        className="font-medium text-[var(--color-foreground)] underline decoration-[var(--color-border)] underline-offset-4 hover:decoration-[var(--color-primary)]"
      >
        What is {field}?
      </button>
      <div
        id={descriptionId}
        role="region"
        aria-label={`${field} explanation`}
        hidden={!expanded}
        className="rounded-md border bg-[var(--color-secondary)] p-3 text-sm leading-6 text-[var(--color-foreground)]"
      >
        {description}
      </div>
      <p>
        <span className="font-medium text-[var(--color-foreground)]">Example: </span>
        {example}
      </p>
    </div>
  );
}
