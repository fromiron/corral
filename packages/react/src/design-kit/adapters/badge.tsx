'use client';

import type { ComponentProps } from 'react';
import { badgeVariants, Badge as KitBadge } from '../components/ui/badge.tsx';

type Variant =
  | 'default'
  | 'destructive'
  | 'error'
  | 'info'
  | 'outline'
  | 'secondary'
  | 'success'
  | 'warning'
  | 'label';
const colors = {
  default: 'gray',
  destructive: 'red',
  error: 'red',
  info: 'blue',
  outline: 'gray',
  secondary: 'gray',
  success: 'green',
  warning: 'amber',
  label: 'gray',
} as const;
export function Badge({
  variant = 'default',
  size = 'default',
  ...props
}: Omit<ComponentProps<typeof KitBadge>, 'variant' | 'size' | 'color'> & {
  variant?: Variant;
  size?: 'default' | 'control' | 'lg' | 'sm';
}) {
  return (
    <KitBadge
      variant={variant === 'outline' ? 'dot' : 'solid'}
      color={colors[variant]}
      size={size === 'sm' ? 'compact' : 'default'}
      data-slot="badge"
      {...props}
    />
  );
}
export { badgeVariants };
