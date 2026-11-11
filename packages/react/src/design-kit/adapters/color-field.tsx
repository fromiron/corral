'use client';

import type { Ref } from 'react';
import { ColorTile } from '../components/ui/color-picker.tsx';
import { useShape } from '../lib/shape-context.tsx';
import { useSizeVariant } from '../lib/size-context.tsx';
import { cn } from './utils.ts';

interface ColorFieldProps {
  /** The hex text field's id, for an external `<label htmlFor>`. */
  id?: string;
  /** The hex text as typed; it may be invalid while the person edits it. */
  text: string;
  /** The opaque `#rrggbb` the tile shows and the picker opens on: the last value that applied. */
  color: string;
  onTextChange: (text: string) => void;
  /** A color chosen in the system picker, as lower-case `#rrggbb`. */
  onColorChange: (color: string) => void;
  onBlur?: () => void;
  invalid?: boolean;
  /** The system picker's accessible name. The text field is named by its external label. */
  pickerLabel: string;
  describedBy?: string;
  inputRef?: Ref<HTMLInputElement>;
  className?: string;
}

/**
 * An opaque `#rrggbb` color as the source picker's trigger draws it (a bordered control with the
 * color tile, then the hex value), with the hex editable in place and the system color picker
 * behind the tile. The text field keeps the Input bridge's hover, focus and invalid states.
 */
function ColorField({
  id,
  text,
  color,
  onTextChange,
  onColorChange,
  onBlur,
  invalid = false,
  pickerLabel,
  describedBy,
  inputRef,
  className,
}: ColorFieldProps) {
  const compact = useSizeVariant() === 'compact';
  const shape = useShape();
  return (
    <span
      data-slot="input-control"
      data-size={compact ? 'compact' : 'default'}
      className={cn(
        'relative inline-flex w-full min-w-0 items-center gap-2 rounded-[var(--shape-input-radius)] border border-border bg-transparent text-foreground transition-colors hover:bg-muted/50 has-[[data-slot=input]:focus-visible]:bg-card has-[[data-slot=input]:focus-visible]:ring-2 has-[[data-slot=input]:focus-visible]:ring-focus-ring has-aria-invalid:border-destructive motion-reduce:transition-none',
        compact ? 'pl-1.5' : 'pl-2',
        className,
      )}
    >
      <span
        className={cn(
          'relative inline-flex shrink-0 has-focus-visible:outline-2 has-focus-visible:outline-solid has-focus-visible:outline-offset-2 has-focus-visible:outline-[color:var(--focus-ring)]',
          shape.bg,
        )}
      >
        <ColorTile color={color} size={compact ? 16 : 20} />
        <input
          type="color"
          value={color}
          aria-label={pickerLabel}
          onChange={(event) => onColorChange(event.target.value.toLowerCase())}
          className="absolute inset-0 size-full cursor-pointer opacity-0"
        />
      </span>
      <input
        ref={inputRef}
        id={id}
        type="text"
        data-slot="input"
        value={text}
        spellCheck={false}
        autoComplete="off"
        autoCapitalize="off"
        aria-invalid={invalid || undefined}
        aria-describedby={describedBy}
        onChange={(event) => onTextChange(event.target.value)}
        onBlur={onBlur}
        className={cn(
          'w-full min-w-0 bg-transparent pr-3 text-body tabular-nums outline-none pointer-coarse:text-base',
          compact
            ? 'h-[calc(var(--control-height-compact)-2px)] pr-2.5 text-[length:var(--fs-body-compact)] leading-[var(--lh-body-compact)] pointer-coarse:text-base'
            : 'h-[calc(var(--control-height)-2px)]',
        )}
      />
    </span>
  );
}

export { ColorField, type ColorFieldProps };
