import { Button, Input, Popover, PopoverPopup } from '@corral/react/design-kit';
import { type ReactNode, type RefObject, useId, useRef } from 'react';
import { useTranslations } from 'use-intl';

export interface LineRange {
  start: number;
  end: number;
}

/**
 * The from/to line fields of a document's "Go to lines…" or "Reference lines…", opened from its
 * more menu beside the control that opened it. The range stays with the document between opens.
 */
export function LineRangePopover({
  open,
  onOpenChange,
  anchor,
  action,
  range,
  lineCount,
  onRange,
  onSubmit,
  disabled = false,
  note,
}: {
  open: boolean;
  onOpenChange(open: boolean): void;
  /** The control the popover sits against and returns focus to. */
  anchor: RefObject<HTMLElement | null>;
  /** The submit label, which also names the popover. */
  action: string;
  range: LineRange;
  lineCount: number;
  onRange(range: LineRange): void;
  onSubmit(range: LineRange): void;
  disabled?: boolean;
  /** One line under the fields: why the action is unavailable, or what it does. */
  note?: ReactNode;
}) {
  const td = useTranslations('Desktop');
  const id = useId();
  const from = useRef<HTMLInputElement>(null);
  const valid = range.start >= 1 && range.end >= range.start && range.end <= lineCount;
  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverPopup
        anchor={anchor}
        align="end"
        padding="compact"
        aria-label={action}
        initialFocus={from}
        finalFocus={anchor}
        className="max-w-[min(22rem,calc(100vw-2rem))]"
      >
        <form
          className="flex flex-col gap-2 p-1"
          onSubmit={(event) => {
            event.preventDefault();
            if (valid && !disabled) onSubmit(range);
          }}
        >
          <div className="flex items-end gap-2">
            <label
              htmlFor={`${id}-from`}
              className="flex flex-col gap-1 text-caption text-muted-foreground"
            >
              {td('fromLine')}
              <Input
                ref={from}
                id={`${id}-from`}
                nativeInput
                size="sm"
                type="number"
                min={1}
                max={lineCount}
                value={range.start}
                onChange={(event) => onRange({ ...range, start: event.target.valueAsNumber || 1 })}
                className="w-20"
              />
            </label>
            <label
              htmlFor={`${id}-to`}
              className="flex flex-col gap-1 text-caption text-muted-foreground"
            >
              {td('toLine')}
              <Input
                id={`${id}-to`}
                nativeInput
                size="sm"
                type="number"
                min={range.start}
                max={lineCount}
                value={range.end}
                onChange={(event) => onRange({ ...range, end: event.target.valueAsNumber || 1 })}
                className="w-20"
              />
            </label>
            <Button type="submit" size="compact" disabled={!valid || disabled}>
              {action}
            </Button>
          </div>
          {note ? <p className="text-caption text-muted-foreground">{note}</p> : null}
        </form>
      </PopoverPopup>
    </Popover>
  );
}
