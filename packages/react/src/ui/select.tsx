'use client';

import { Select as SelectPrimitive } from '@base-ui/react/select';
import { CheckIcon, ChevronDownIcon } from 'lucide-react';
import type * as React from 'react';
import { cn } from './utils.ts';

// One select for the workbench (Workbench polish P0): the same trigger as a ghost or outline
// button, the same popup as the menus, keyboard and screen reader behaviour from base-ui.

export type SelectOption<T extends string> = {
  value: T;
  label: React.ReactNode;
  /** A second, muted line in the popup only. */
  hint?: React.ReactNode;
  disabled?: boolean;
  /** A heading for consecutive options with the same group. */
  group?: string;
};

/** Runs of options under one heading; ungrouped options form untitled runs. */
function sections<T extends string>(options: readonly SelectOption<T>[]) {
  const out: { title: string | undefined; options: SelectOption<T>[] }[] = [];
  for (const option of options) {
    const last = out.at(-1);
    if (last && last.title === option.group) last.options.push(option);
    else out.push({ title: option.group, options: [option] });
  }
  return out;
}

export function Select<T extends string>({
  value,
  onValueChange,
  options,
  label,
  placeholder,
  variant = 'outline',
  size = 'sm',
  disabled,
  className,
  icon,
  align = 'start',
  open,
  onOpenChange,
}: {
  value: T | null;
  onValueChange: (value: T) => void;
  options: readonly SelectOption<T>[];
  /** The accessible name; the trigger shows the chosen option. */
  label: string;
  placeholder?: React.ReactNode;
  variant?: 'outline' | 'ghost' | 'chip';
  size?: 'xs' | 'sm';
  disabled?: boolean;
  className?: string;
  icon?: React.ReactNode;
  align?: 'start' | 'center' | 'end';
  /** Lets a command open the list (e.g. `/team`). */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  const items = options.map((o) => ({ value: o.value, label: o.label }));
  const renderItem = (option: SelectOption<T>) => (
    <SelectPrimitive.Item
      key={option.value}
      value={option.value}
      disabled={option.disabled}
      className="grid cursor-pointer grid-cols-[1rem_1fr] items-start gap-2 rounded-sm px-2 py-1.5 text-ui text-foreground outline-none select-none data-disabled:cursor-not-allowed data-disabled:opacity-60 data-highlighted:bg-subtle"
    >
      <SelectPrimitive.ItemIndicator className="col-start-1 mt-0.5">
        <CheckIcon className="size-3.5" />
      </SelectPrimitive.ItemIndicator>
      <span className="col-start-2 flex min-w-0 flex-col">
        <SelectPrimitive.ItemText className="truncate">{option.label}</SelectPrimitive.ItemText>
        {option.hint ? <span className="text-xs text-muted-foreground">{option.hint}</span> : null}
      </span>
    </SelectPrimitive.Item>
  );
  return (
    <SelectPrimitive.Root
      items={items}
      value={value}
      onValueChange={(next) => {
        if (next !== null) onValueChange(next as T);
        // A controlled list closes on a choice too.
        onOpenChange?.(false);
      }}
      disabled={disabled}
      {...(open === undefined ? {} : { open })}
      {...(onOpenChange ? { onOpenChange: (next: boolean) => onOpenChange(next) } : {})}
    >
      <SelectPrimitive.Trigger
        aria-label={label}
        data-slot="select-trigger"
        className={cn(
          'inline-flex min-w-0 max-w-full cursor-pointer items-center gap-1.5 rounded-[var(--control-radius)] text-foreground outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-60 data-popup-open:bg-subtle [&_svg]:shrink-0',
          size === 'xs' ? 'h-6 px-1.5 text-xs' : 'h-7 px-2 text-ui',
          variant === 'outline' &&
            'border border-input fill-control hover:bg-subtle focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/24',
          variant === 'ghost' && 'text-muted-foreground hover:bg-subtle hover:text-foreground',
          variant === 'chip' &&
            'rounded-full text-muted-foreground hover:bg-subtle hover:text-foreground',
          className,
        )}
      >
        {icon}
        <SelectPrimitive.Value className="min-w-0 truncate" placeholder={placeholder} />
        <SelectPrimitive.Icon className="text-muted-foreground">
          <ChevronDownIcon className="size-3.5" />
        </SelectPrimitive.Icon>
      </SelectPrimitive.Trigger>
      <SelectPrimitive.Portal>
        <SelectPrimitive.Positioner
          className="z-[130]"
          sideOffset={4}
          align={align}
          alignItemWithTrigger={false}
        >
          <SelectPrimitive.Popup
            className="dropdown-glass max-h-(--available-height) min-w-(--anchor-width) overflow-y-auto rounded-lg p-1 shadow-popup outline-none [-webkit-app-region:no-drag]"
            data-slot="select-popup"
          >
            {sections(options).map((section) =>
              section.title ? (
                <SelectPrimitive.Group key={section.title}>
                  <SelectPrimitive.GroupLabel className="px-2 pt-1.5 pb-0.5 text-2xs font-medium text-muted-foreground">
                    {section.title}
                  </SelectPrimitive.GroupLabel>
                  {section.options.map(renderItem)}
                </SelectPrimitive.Group>
              ) : (
                section.options.map(renderItem)
              ),
            )}
          </SelectPrimitive.Popup>
        </SelectPrimitive.Positioner>
      </SelectPrimitive.Portal>
    </SelectPrimitive.Root>
  );
}
