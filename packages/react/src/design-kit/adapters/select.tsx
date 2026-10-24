'use client';

import { Fragment, type ReactNode } from 'react';
import {
  Select as KitSelect,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectSeparator,
  SelectTrigger,
} from '../components/ui/select.tsx';
import { cn } from '../lib/utils.ts';

export type SelectOption<T extends string> = {
  value: T;
  label: ReactNode;
  hint?: ReactNode;
  disabled?: boolean;
  group?: string;
};
export function Select<T extends string>({
  id,
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
  id?: string;
  value: T | null;
  onValueChange: (value: T) => void;
  options: readonly SelectOption<T>[];
  label: string;
  placeholder?: ReactNode;
  variant?: 'outline' | 'ghost' | 'chip';
  size?: 'xs' | 'sm';
  disabled?: boolean;
  className?: string;
  icon?: ReactNode;
  align?: 'start' | 'center' | 'end';
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  const hasHints = options.some((option) => option.hint);
  const groups: { title?: string; options: { option: SelectOption<T>; index: number }[] }[] = [];
  options.forEach((option, index) => {
    const previous = groups.at(-1);
    if (previous && previous.title === option.group && (option.group || !hasHints))
      previous.options.push({ option, index });
    else groups.push({ title: option.group, options: [{ option, index }] });
  });
  const renderItem = ({ option, index }: { option: SelectOption<T>; index: number }) => (
    <SelectItem
      key={index}
      index={index}
      value={option.value}
      disabled={option.disabled}
      className={option.hint ? 'h-auto py-2' : undefined}
    >
      {option.hint ? (
        <span className="flex min-w-0 flex-col gap-1 whitespace-normal">
          <span>{option.label}</span>
          <span className="text-caption text-muted-foreground">{option.hint}</span>
        </span>
      ) : (
        option.label
      )}
    </SelectItem>
  );
  return (
    <KitSelect
      value={value ?? ''}
      onValueChange={(next) => onValueChange(next as T)}
      items={options.map(({ value, label }) => ({ value, label }))}
      // A chip sits among compact buttons (the composer, the top bar) and hugs its value.
      size={size === 'xs' || variant === 'chip' ? 'compact' : 'default'}
      disabled={disabled}
      open={open}
      onOpenChange={onOpenChange}
    >
      <SelectTrigger
        id={id}
        aria-label={label}
        placeholder={placeholder}
        leadingContent={icon}
        variant={variant === 'outline' ? 'bordered' : 'borderless'}
        className={cn(variant !== 'outline' && 'min-w-0 max-w-full', className)}
        data-slot="select-trigger"
      />
      <SelectContent
        align={align}
        className={hasHints ? 'max-w-[min(24rem,calc(100vw-2rem))]' : undefined}
      >
        {groups.map((group, index) => (
          <Fragment key={group.options[0]?.index}>
            {index > 0 && <SelectSeparator />}
            {group.title || hasHints ? (
              <SelectGroup>
                {group.title && <SelectLabel>{group.title}</SelectLabel>}
                {group.options.map(renderItem)}
              </SelectGroup>
            ) : (
              group.options.map(renderItem)
            )}
          </Fragment>
        ))}
      </SelectContent>
    </KitSelect>
  );
}
