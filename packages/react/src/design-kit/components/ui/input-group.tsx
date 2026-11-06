'use client';

import { Field } from '@base-ui/react/field';
import {
  createContext,
  forwardRef,
  type HTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  useContext,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useFluidHover, useRegisterFluidHoverItem } from '../../hooks/use-fluid-hover.ts';
import { fontWeights } from '../../lib/font-weight.ts';
import type { IconComponent } from '../../lib/icon-context.tsx';
import { useShape } from '../../lib/shape-context.tsx';
import { SizeProvider, type SizeVariant, useSize } from '../../lib/size-context.tsx';
import { cn } from '../../lib/utils.ts';

// InputGroup stacks labelled text fields that share one fluid hover scope.
// Each field draws its own hover/focus state; there is no shared highlight.

interface InputGroupContextValue {
  registerItem: (index: number, element: HTMLElement | null) => void;
  activeIndex: number | null;
}

const InputGroupContext = createContext<InputGroupContextValue | null>(null);

function useInputGroup() {
  const ctx = useContext(InputGroupContext);
  if (!ctx) throw new Error('useInputGroup must be used within an InputGroup');
  return ctx;
}

interface InputGroupProps extends HTMLAttributes<HTMLDivElement> {
  children: ReactNode;
  /** Pins the group's fields to one step of the size ladder (default 36px,
   *  compact 28px). Omitted, they follow the surrounding SizeProvider. */
  size?: SizeVariant;
}

const InputGroup = forwardRef<HTMLDivElement, InputGroupProps>(
  ({ children, size, className, ...props }, ref) => {
    const containerRef = useRef<HTMLDivElement>(null);

    const { activeIndex, handlers, registerItem } = useFluidHover(containerRef);

    const contextValue = useMemo(
      () => ({ registerItem, activeIndex }),
      [registerItem, activeIndex],
    );

    const group = (
      <InputGroupContext.Provider value={contextValue}>
        {/* biome-ignore lint/a11y/noStaticElementInteractions: Pointer handlers only track decorative field hover state. */}
        <div
          ref={(node) => {
            (containerRef as React.MutableRefObject<HTMLDivElement | null>).current = node;
            if (typeof ref === 'function') ref(node);
            else if (ref) (ref as React.MutableRefObject<HTMLDivElement | null>).current = node;
          }}
          onMouseEnter={handlers.onMouseEnter}
          onMouseMove={handlers.onMouseMove}
          onMouseLeave={handlers.onMouseLeave}
          // `relative`: the fluid hover hook measures items via offsetTop, so
          // this div must be their offsetParent.
          className={cn('relative flex flex-col gap-3 w-72 max-w-full', className)}
          {...props}
        >
          {children}
        </div>
      </InputGroupContext.Provider>
    );

    return size ? <SizeProvider size={size}>{group}</SizeProvider> : group;
  },
);

InputGroup.displayName = 'InputGroup';

interface InputFieldProps
  extends Omit<InputHTMLAttributes<HTMLInputElement>, 'onChange' | 'index'> {
  label: string;
  /** Keep the label for assistive tech but don't render it — for inline
   *  fields (a toolbar search) where the placeholder carries the meaning. */
  labelHidden?: boolean;
  placeholder?: string;
  icon?: IconComponent;
  index: number;
  value: string;
  onChange: (value: string) => void;
  error?: string;
  disabled?: boolean;
  className?: string;
}

const InputField = forwardRef<HTMLDivElement, InputFieldProps>(
  (
    {
      label,
      labelHidden,
      placeholder,
      icon: Icon,
      index,
      value,
      onChange,
      error,
      disabled,
      className,
      ...props
    },
    ref,
  ) => {
    const internalRef = useRef<HTMLDivElement>(null);
    const inputRef = useRef<HTMLElement | null>(null);
    const { registerItem, activeIndex } = useInputGroup();
    const [isFocused, setIsFocused] = useState(false);
    const shape = useShape();
    const sizeClasses = useSize();
    const compact = sizeClasses.variant === 'compact';

    useRegisterFluidHoverItem(registerItem, index, internalRef);

    // Lit when hovered or focused, so keyboard users get the same cue.
    const isActive = activeIndex === index;
    const labelActive = isActive || isFocused;

    const handleFocus = () => {
      setIsFocused(true);
    };

    const handleBlur = () => {
      setIsFocused(false);
    };

    // Precedence: disabled, error, focused, hovered, rest. Resting bounds stay
    // visible; an error adds its red ring on hover or focus.
    let bgClass: string;
    let ringClass: string;

    if (disabled) {
      bgClass = 'bg-transparent';
      ringClass = 'ring-border';
    } else if (error) {
      bgClass = isFocused ? 'bg-card' : isActive ? 'bg-destructive-light/60' : 'bg-transparent';
      ringClass = isFocused || isActive ? 'ring-destructive/50' : 'ring-border';
    } else if (isFocused) {
      bgClass = 'bg-card';
      ringClass = 'ring-border';
    } else if (isActive) {
      bgClass = 'bg-muted/50';
      ringClass = 'ring-border';
    } else {
      bgClass = 'bg-transparent';
      ringClass = 'ring-border';
    }

    return (
      // Base UI Field wires label htmlFor, error aria-describedby, and aria-invalid.
      <Field.Root
        ref={(node) => {
          (internalRef as React.MutableRefObject<HTMLDivElement | null>).current = node;
          if (typeof ref === 'function') ref(node);
          else if (ref) (ref as React.MutableRefObject<HTMLDivElement | null>).current = node;
        }}
        invalid={!!error}
        disabled={disabled}
        className={cn(
          'flex flex-col gap-1 cursor-text',
          disabled && 'opacity-50 pointer-events-none',
          className,
        )}
      >
        {/* sr-only when hidden so the field keeps its accessible name. */}
        <Field.Label
          className={cn(
            labelHidden ? 'sr-only' : 'inline-grid',
            sizeClasses.text,
            // Keep the persistent label aligned with the control text.
            !labelHidden && (compact ? 'pl-2' : 'pl-2.5'),
          )}
        >
          {/* An invisible semibold copy reserves the bold width. */}
          <span
            className="col-start-1 row-start-1 invisible"
            style={{ fontVariationSettings: fontWeights.semibold }}
            aria-hidden="true"
          >
            {label}
          </span>
          <span
            className={cn(
              'col-start-1 row-start-1',
              error ? 'text-destructive' : 'text-muted-foreground',
            )}
            style={{
              fontVariationSettings: fontWeights.normal,
            }}
          >
            {label}
          </span>
        </Field.Label>

        {/* biome-ignore lint/a11y/noStaticElementInteractions: Padding clicks focus the native field, which retains keyboard behavior. */}
        <div
          data-slot="input-control"
          onMouseDown={(e) => {
            // A click anywhere in the container (icon, padding) focuses the
            // input without disturbing its own caret placement.
            if (e.target === inputRef.current) return;
            e.preventDefault();
            inputRef.current?.focus();
          }}
          className={cn(
            `flex items-center ${sizeClasses.gap} ${shape.input} ${
              compact ? 'px-2' : 'px-2.5'
            } ${sizeClasses.control} ring-1 transition-all duration-80 has-focus-visible:ring-2 has-focus-visible:ring-focus-ring`,
            bgClass,
            ringClass,
          )}
        >
          {Icon && (
            <Icon
              size={sizeClasses.icon}
              strokeWidth={labelActive ? 2 : 1.5}
              className={cn(
                'shrink-0 transition-[color,stroke-width] duration-80',
                labelActive ? 'text-foreground' : 'text-muted-foreground',
              )}
            />
          )}
          <Field.Control
            ref={inputRef}
            type="text"
            value={value}
            onChange={(e) => onChange(e.target.value)}
            onFocus={handleFocus}
            onBlur={handleBlur}
            placeholder={placeholder}
            className={cn(
              'w-full rounded-none bg-transparent text-foreground placeholder:text-muted-foreground outline-none font-[inherit]',
              sizeClasses.field,
            )}
            style={{ fontVariationSettings: fontWeights.normal }}
            {...props}
          />
        </div>

        {/* `match` keeps it visible while the controlled `error` prop is set. */}
        {error && (
          <Field.Error
            match
            className={cn(
              'text-destructive',
              compact
                ? 'text-[length:var(--fs-caption-compact,11px)] leading-[var(--lh-caption-compact,14px)] pl-2'
                : 'text-[length:var(--fs-caption,12px)] leading-[var(--lh-caption,16px)] pl-2.5',
            )}
            style={{ fontVariationSettings: fontWeights.normal }}
          >
            {error}
          </Field.Error>
        )}
      </Field.Root>
    );
  },
);

InputField.displayName = 'InputField';

export { InputField, InputGroup };
export default InputGroup;
