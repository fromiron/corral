'use client';

import { Field as FieldPrimitive } from '@base-ui/react/field';
import { mergeProps } from '@base-ui/react/merge-props';
import type * as React from 'react';

import { cn } from './utils.ts';

type TextareaProps = React.ComponentProps<'textarea'> & {
  size?: 'sm' | 'default' | 'lg' | number;
  unstyled?: boolean;
};

function Textarea({ className, size = 'default', unstyled = false, ...props }: TextareaProps) {
  return (
    <span
      className={
        cn(
          !unstyled &&
            'relative inline-flex w-full rounded-[var(--shape-input-radius)] border border-transparent bg-transparent text-body text-foreground transition-colors hover:border-border hover:bg-muted/50 has-focus-visible:border-border has-focus-visible:bg-card has-focus-visible:ring-2 has-focus-visible:ring-focus-ring has-aria-invalid:border-destructive has-disabled:opacity-50 motion-reduce:transition-none',
          className,
        ) || undefined
      }
      data-size={size}
      data-slot="textarea-control"
    >
      <FieldPrimitive.Control
        render={(defaultProps) => (
          <textarea
            className={cn(
              'field-sizing-content min-h-20 max-h-64 w-full rounded-[inherit] px-3 py-2 text-body outline-none wrap-anywhere placeholder:text-muted-foreground pointer-coarse:text-base',
              size === 'sm' &&
                'min-h-16 px-2.5 py-1.5 text-[length:var(--fs-body-compact)] leading-[var(--lh-body-compact)] pointer-coarse:text-base',
              size === 'lg' && 'min-h-24 py-2',
            )}
            data-slot="textarea"
            {...mergeProps(defaultProps, props)}
          />
        )}
      />
    </span>
  );
}

export { Textarea, type TextareaProps };
