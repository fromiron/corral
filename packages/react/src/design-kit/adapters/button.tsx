'use client';

import { mergeProps } from '@base-ui/react/merge-props';
import { useRender } from '@base-ui/react/use-render';
import type { ComponentProps, ReactElement } from 'react';
import {
  Button as KitButton,
  buttonVariants as kitButtonVariants,
} from '../components/ui/button.tsx';
import { cn } from '../lib/utils.ts';

const variants = {
  primary: 'primary',
  default: 'primary',
  secondary: 'secondary',
  tertiary: 'tertiary',
  outline: 'tertiary',
  glass: 'tertiary',
  ghost: 'ghost',
  'ghost-muted': 'ghost',
  destructive: 'primary',
  'destructive-outline': 'tertiary',
  'ghost-destructive': 'ghost',
  'warning-outline': 'tertiary',
  link: 'ghost',
  overlay: 'secondary',
  'media-close': 'secondary',
  'media-navigation': 'secondary',
} as const;
const sizes = {
  default: 'default',
  compact: 'compact',
  icon: 'icon',
  'icon-compact': 'icon-compact',
  sm: 'compact',
  xs: 'compact',
  micro: 'compact',
  'sm-multiline': 'compact',
  lg: 'default',
  xl: 'default',
  'icon-sm': 'icon-compact',
  'icon-xs': 'icon-compact',
  'icon-micro': 'icon-compact',
  'icon-tiny': 'icon-compact',
  'icon-lg': 'icon',
  'icon-xl': 'icon',
} as const;
export type ButtonVariant = keyof typeof variants;
export type ButtonSize = keyof typeof sizes;
const semanticClasses: Partial<Record<ButtonVariant, string>> = {
  destructive: '[--foreground:var(--destructive)] [--background:var(--destructive-contrast)]',
  'destructive-outline': 'text-destructive-foreground',
  'ghost-destructive': 'text-destructive-foreground hover:text-destructive-foreground',
  'warning-outline': 'text-warning-foreground',
  overlay:
    '[--tint:var(--media-control-background)] [--tint-hover:var(--media-control-background)] text-white',
  'media-close':
    '[--tint:var(--media-control-background)] [--tint-hover:var(--media-control-background)] text-white',
  'media-navigation':
    'absolute top-1/2 z-20 -translate-y-1/2 [--tint:var(--media-control-background)] [--tint-hover:var(--media-control-background)] text-white',
};
interface ButtonProps extends useRender.ComponentProps<'button'> {
  variant?: ButtonVariant;
  size?: ButtonSize;
}

export function Button({
  className,
  variant = 'default',
  size = 'default',
  render,
  ...props
}: ButtonProps) {
  const defaultProps = {
    className: cn(
      // Existing callers pass icon and multi-part labels as children instead of icon slots.
      '[&>span:last-child>span]:contents [&_svg]:shrink-0 [&_svg]:pointer-events-none',
      sizes[size] === 'compact' || sizes[size] === 'icon-compact'
        ? "[&_svg:not([class*='size-'])]:size-3.5"
        : "[&_svg:not([class*='size-'])]:size-4",
      semanticClasses[variant],
      size === 'sm-multiline' && 'h-auto min-h-7 whitespace-normal',
      className,
    ),
    'data-slot': 'button',
    'data-size': size,
    type: render ? undefined : ('button' as const),
  };
  const element = useRender({
    defaultTagName: 'button',
    props: mergeProps<'button'>(defaultProps, props),
    render,
  }) as ReactElement<ComponentProps<'button'>>;
  return (
    <KitButton
      variant={variants[variant]}
      size={sizes[size]}
      render={element}
      ref={element.props.ref}
    />
  );
}

export function buttonVariants({
  variant = 'default',
  size = 'default',
  className,
}: {
  variant?: ButtonVariant;
  size?: ButtonSize;
  className?: string;
} = {}) {
  return cn(
    kitButtonVariants({ variant: variants[variant], size: sizes[size] }),
    semanticClasses[variant],
    className,
  );
}

export function InlineButton({
  tone = 'default',
  ...props
}: useRender.ComponentProps<'button'> & { tone?: 'default' | 'muted' | 'destructive' | 'picker' }) {
  return (
    <Button
      variant={tone === 'destructive' ? 'ghost-destructive' : 'ghost'}
      size="compact"
      {...props}
    />
  );
}
