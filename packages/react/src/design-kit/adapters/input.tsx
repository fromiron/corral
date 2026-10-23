'use client';

import { Input as InputPrimitive } from '@base-ui/react/input';
import type * as React from 'react';

import { cn } from './utils.ts';

type InputProps = Omit<InputPrimitive.Props & React.RefAttributes<HTMLInputElement>, 'size'> & {
  size?: 'sm' | 'compact' | 'default' | 'lg' | number;
  font?: 'default' | 'mono';
  unstyled?: boolean;
  nativeInput?: boolean;
};

function Input({
  className,
  size = 'default',
  font = 'default',
  unstyled = false,
  nativeInput = false,
  ...props
}: InputProps) {
  const inputClassName = cn(
    'w-full min-w-0 rounded-[inherit] px-3 text-body outline-none placeholder:text-muted-foreground pointer-coarse:text-base',
    unstyled ? 'h-9' : 'h-[calc(var(--control-height)-2px)]',
    (size === 'compact' || size === 'sm') && [
      unstyled ? 'h-7' : 'h-[calc(var(--control-height-compact)-2px)]',
      'px-2.5 text-[length:var(--fs-body-compact)] leading-[var(--lh-body-compact)] pointer-coarse:text-base',
    ],
    props.type === 'search' &&
      '[&::-webkit-search-cancel-button]:appearance-none [&::-webkit-search-decoration]:appearance-none [&::-webkit-search-results-button]:appearance-none [&::-webkit-search-results-decoration]:appearance-none',
    props.type === 'number' &&
      '[appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none',
    props.type === 'file' &&
      'text-muted-foreground file:me-3 file:bg-transparent file:font-medium file:text-foreground file:text-sm',
  );
  let inputElement: React.ReactElement;

  if (nativeInput) {
    const { style, onValueChange: _onValueChange, ...nativeInputProps } = props;
    const nativeStyle = typeof style === 'function' ? undefined : style;

    inputElement = (
      <input
        className={inputClassName}
        data-slot="input"
        size={typeof size === 'number' ? size : undefined}
        style={nativeStyle}
        {...(nativeInputProps as React.ComponentProps<'input'>)}
      />
    );
  } else {
    inputElement = (
      <InputPrimitive
        className={inputClassName}
        data-slot="input"
        size={typeof size === 'number' ? size : undefined}
        {...props}
      />
    );
  }

  return (
    <span
      className={
        cn(
          !unstyled &&
            'relative inline-flex w-full rounded-[var(--shape-input-radius)] border border-transparent bg-transparent text-foreground transition-colors hover:border-border hover:bg-muted/50 has-focus-visible:border-border has-focus-visible:bg-card has-focus-visible:ring-2 has-focus-visible:ring-focus-ring has-aria-invalid:border-destructive has-disabled:opacity-50 motion-reduce:transition-none',
          font === 'mono' && 'font-mono tabular-nums',
          className,
        ) || undefined
      }
      data-size={size}
      data-slot="input-control"
    >
      {inputElement}
    </span>
  );
}

export { Input, type InputProps };
