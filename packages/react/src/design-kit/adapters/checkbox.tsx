'use client';

import { CheckboxGroup, CheckboxItem } from '../components/ui/checkbox-group.tsx';
import { cn } from './utils.ts';

/**
 * One kit CheckboxItem in its own CheckboxGroup, for a single confirmation or an item that sits
 * beside other content (a diff, a table row). A flat list of choices composes CheckboxGroup
 * directly. The kit row has no disabled state, so the row is inert and dimmed instead.
 */
export function Checkbox({
  label,
  checked,
  onToggle,
  disabled = false,
  className,
}: {
  label: string;
  checked: boolean;
  onToggle: () => void;
  disabled?: boolean;
  className?: string;
}) {
  return (
    <CheckboxGroup
      checkedIndices={new Set(checked ? [0] : [])}
      className={cn('w-fit min-w-0', className)}
    >
      <CheckboxItem
        index={0}
        label={label}
        checked={checked}
        onToggle={() => {
          if (!disabled) onToggle();
        }}
        aria-disabled={disabled || undefined}
        tabIndex={disabled ? -1 : 0}
        className={cn(disabled && 'pointer-events-none opacity-50')}
      />
    </CheckboxGroup>
  );
}
