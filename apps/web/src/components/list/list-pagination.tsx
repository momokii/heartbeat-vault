import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';

export const LIST_PAGE_SIZES = [5, 10, 15, 25, 50] as const;

type ListPaginationProps = {
  readonly idPrefix: string;
  readonly pageSize: number;
  readonly onPageSizeChange: (size: number) => void;
  readonly canPrev: boolean;
  readonly onPrev: () => void;
  readonly canNext: boolean;
  readonly onNext: () => void;
  readonly shownFrom: number;
  readonly shownTo: number;
};

/**
 * Shared pagination bar for every list in the app: page-size chooser with
 * Previous/Next navigation and the currently visible row range.
 */
export function ListPagination({
  idPrefix,
  pageSize,
  onPageSizeChange,
  canPrev,
  onPrev,
  canNext,
  onNext,
  shownFrom,
  shownTo,
}: ListPaginationProps) {
  if (shownTo === 0) return null;
  return (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <Label htmlFor={`${idPrefix}-page-size`} className="text-xs">
          Rows per page
        </Label>
        <Select
          id={`${idPrefix}-page-size`}
          className="h-8 w-20 text-xs"
          value={String(pageSize)}
          onChange={event => onPageSizeChange(Number(event.currentTarget.value))}
        >
          {LIST_PAGE_SIZES.map(size => (
            <option key={size} value={size}>
              {size}
            </option>
          ))}
        </Select>
        <span className="text-xs text-[var(--color-muted-foreground)]">
          Showing {shownFrom}–{shownTo}
        </span>
      </div>
      <div className="flex gap-2">
        <Button type="button" variant="outline" size="sm" disabled={!canPrev} onClick={onPrev}>
          Previous
        </Button>
        <Button type="button" variant="outline" size="sm" disabled={!canNext} onClick={onNext}>
          Next
        </Button>
      </div>
    </div>
  );
}
