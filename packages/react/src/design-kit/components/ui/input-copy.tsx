'use client';

import { AnimatePresence, motion } from 'motion/react';
import {
  forwardRef,
  type HTMLAttributes,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from 'react';
import { focusRing } from '../../lib/focus.ts';
import { fontWeights } from '../../lib/font-weight.ts';
import { useIcons } from '../../lib/icon-context.tsx';
import { useShape } from '../../lib/shape-context.tsx';
import { type SizeVariant, useSize } from '../../lib/size-context.tsx';
import { spring, tween } from '../../lib/springs.ts';
import { cn } from '../../lib/utils.ts';
import { Tooltip } from './tooltip.tsx';

// InputCopy shows a value and copies it on click. The whole row is one
// <button> so the full value reads as the click target. The result (check or
// red ×) shows in place for 2000ms.

type InputCopyVariant = 'icon' | 'button';
type InputCopyAlign = 'right' | 'left';

interface InputCopyLabels {
  /** Button text, and the button's name when `label` names the value. */
  copy: string;
  /** Result text, name and tooltip after a copy. */
  copied: string;
  /** Button text after a failed copy. */
  failed: string;
  /** Name and tooltip after a failed copy. */
  copyFailed: string;
  /** Name and tooltip without a `label`. */
  copyToClipboard: string;
}

const defaultLabels: InputCopyLabels = {
  copy: 'Copy',
  copied: 'Copied',
  failed: 'Failed',
  copyFailed: 'Copy failed',
  copyToClipboard: 'Copy to clipboard',
};

interface InputCopyProps extends Omit<HTMLAttributes<HTMLDivElement>, 'children'> {
  /** The value to display and copy to clipboard. */
  value: string;
  /** Optional label displayed above the input. */
  label?: string;
  /** Callback fired after the value is copied. */
  onCopy?: () => void;
  /** Whether the component is disabled. */
  disabled?: boolean;
  /** Display variant: icon-only with tooltip, or button with label. */
  variant?: InputCopyVariant;
  /** Position of the copy action relative to the value. */
  align?: InputCopyAlign;
  /** Pins the field to one step of the size ladder (default 36px, compact
   *  28px). Omitted, it follows the surrounding SizeProvider. */
  size?: SizeVariant;
  /** Localized action and result words; the source English is the default. */
  labels?: Partial<InputCopyLabels>;
}

const InputCopy = forwardRef<HTMLDivElement, InputCopyProps>(
  (
    {
      value,
      label,
      onCopy,
      disabled,
      variant = 'icon',
      align = 'right',
      size,
      labels: labelOverrides,
      className,
      ...props
    },
    ref,
  ) => {
    const labels = { ...defaultLabels, ...labelOverrides };
    // The longest result word reserves the width, so label swaps keep it.
    const sizer = [labels.copy, labels.copied, labels.failed].reduce((a, b) =>
      b.length > a.length ? b : a,
    );
    const icons = useIcons();
    const CopyIcon = icons.copy;
    const [status, setStatus] = useState<'idle' | 'copied' | 'error'>('idle');
    // Keys the result glyphs so a repeat copy replays the draw animation.
    const [copyCount, setCopyCount] = useState(0);
    // "idle" = normal tooltip behavior, "copied" = force open, "suppressed" = force closed
    const [tooltipState, setTooltipState] = useState<'idle' | 'copied' | 'suppressed'>('idle');
    const timeoutRef = useRef<ReturnType<typeof setTimeout>>(null);
    const tooltipVisibleRef = useRef(false);
    const tooltipWasVisibleRef = useRef(false);
    const shape = useShape();
    const sizeClasses = useSize(size);
    // Row height comes from child padding: py-2 → 36px, py-1 → 28px.
    const rowPy = sizeClasses.variant === 'compact' ? 'py-1' : 'py-2';

    // The button's accessible name reads "Copy <label>" via aria-labelledby.
    const generatedId = useId();
    const labelId = label ? `${generatedId}-label` : undefined;
    const buttonId = `${generatedId}-button`;

    const handlePointerDown = useCallback(() => {
      // Capture tooltip visibility before the tooltip closes it on pointer down
      tooltipWasVisibleRef.current = tooltipVisibleRef.current;
    }, []);

    // Fallback for when the Clipboard API is unavailable or denied (insecure
    // context, permissions policy).
    const copyViaExecCommand = useCallback(() => {
      const textarea = document.createElement('textarea');
      textarea.value = value;
      textarea.setAttribute('readonly', '');
      textarea.style.position = 'fixed';
      textarea.style.opacity = '0';
      // 16px: iOS Safari zooms into focused fields with smaller text.
      textarea.style.fontSize = '16px';
      document.body.appendChild(textarea);
      textarea.select();
      // iOS Safari's select() only moves the caret; the range selects the text.
      textarea.setSelectionRange(0, textarea.value.length);
      let ok = false;
      try {
        ok = document.execCommand('copy');
      } catch {
        ok = false;
      }
      document.body.removeChild(textarea);
      return ok;
    }, [value]);

    const handleCopy = useCallback(async () => {
      if (disabled) return;
      let ok = true;
      try {
        await navigator.clipboard.writeText(value);
      } catch {
        ok = copyViaExecCommand();
      }
      setStatus(ok ? 'copied' : 'error');
      setCopyCount((c) => c + 1);
      // Show "Copied" only if the tooltip was already open when the press began.
      setTooltipState(tooltipWasVisibleRef.current ? 'copied' : 'suppressed');
      if (ok) onCopy?.();
      // Afterwards the tooltip stays suppressed until the pointer re-enters,
      // so it doesn't reopen under a resting cursor.
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
      timeoutRef.current = setTimeout(() => {
        setStatus('idle');
        setTooltipState('suppressed');
      }, 2000);
    }, [value, disabled, onCopy, copyViaExecCommand]);

    const handleTooltipOpenChange = useCallback((open: boolean) => {
      tooltipVisibleRef.current = open;
    }, []);

    useEffect(() => {
      return () => {
        if (timeoutRef.current) clearTimeout(timeoutRef.current);
      };
    }, []);

    // Re-entering re-arms the hover tooltip; leaving closes a "Copied" one.
    const handleMouseEnter = useCallback(() => {
      setTooltipState((prev) => (prev === 'suppressed' ? 'idle' : prev));
    }, []);

    const handleMouseLeave = useCallback(() => {
      setTooltipState((prev) => (prev === 'copied' ? 'suppressed' : prev));
    }, []);

    const iconSwitch = (
      <AnimatePresence mode="wait" initial={false}>
        {status === 'error' ? (
          <motion.span
            key={`error-${copyCount}`}
            initial={{ opacity: 0, scale: 0.6 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.8 }}
            transition={spring.fast}
            className="flex items-center justify-center text-destructive [&_svg]:stroke-[1.5] [&_svg]:transition-[stroke-width] [&_svg]:duration-80 group-hover:[&_svg]:stroke-[2]"
          >
            <svg
              aria-hidden="true"
              width={14}
              height={14}
              viewBox="2 4 20 16"
              fill="none"
              stroke="currentColor"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <motion.path
                d="M9 9L15 15M15 9L9 15"
                initial={{ pathLength: 0 }}
                animate={{
                  pathLength: 1,
                  transition: tween.fast,
                }}
              />
            </svg>
          </motion.span>
        ) : status === 'copied' ? (
          <motion.span
            key={`check-${copyCount}`}
            initial={{ opacity: 0, scale: 0.6 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.8 }}
            transition={spring.fast}
            className="flex items-center justify-center [&_svg]:stroke-[1.5] [&_svg]:transition-[stroke-width] [&_svg]:duration-80 group-hover:[&_svg]:stroke-[2]"
          >
            <svg
              aria-hidden="true"
              width={14}
              height={14}
              viewBox="2 4 20 16"
              fill="none"
              stroke="currentColor"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <motion.path
                d="M6 12L10 16L18 8"
                initial={{ pathLength: 0 }}
                animate={{
                  pathLength: 1,
                  transition: tween.fast,
                }}
              />
            </svg>
          </motion.span>
        ) : (
          <motion.span
            key="copy"
            initial={{ opacity: 0, scale: 0.8 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.8 }}
            transition={spring.fast}
            className="flex items-center justify-center"
          >
            <CopyIcon
              size={14}
              strokeWidth={1.5}
              className="transition-[stroke-width] duration-80 group-hover:stroke-[2]"
            />
          </motion.span>
        )}
      </AnimatePresence>
    );

    const actionElement =
      variant === 'button' ? (
        <span
          className={cn(
            'shrink-0 flex items-center gap-1.5 px-1.5 transition-colors duration-80',
            rowPy,
            sizeClasses.text,
            'text-muted-foreground group-hover:text-foreground',
          )}
          style={{ fontVariationSettings: fontWeights.normal }}
        >
          <AnimatePresence mode="wait" initial={false}>
            {status === 'error' ? (
              <motion.span
                key={`error-label-${copyCount}`}
                className="flex items-center gap-1.5 text-destructive"
                initial={{ opacity: 0, scale: 0.6 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.8 }}
                transition={spring.fast}
              >
                <span className="flex items-center justify-center">
                  <svg
                    aria-hidden="true"
                    width={14}
                    height={14}
                    viewBox="2 4 20 16"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth={2}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <motion.path
                      d="M9 9L15 15M15 9L9 15"
                      initial={{ pathLength: 0 }}
                      animate={{
                        pathLength: 1,
                        transition: tween.fast,
                      }}
                    />
                  </svg>
                </span>
                {/* An invisible copy of the longest word sizes the cell so label swaps keep the width. */}
                <span className="select-none inline-grid text-left">
                  <span className="col-start-1 row-start-1 invisible" aria-hidden="true">
                    {sizer}
                  </span>
                  <span className="col-start-1 row-start-1">{labels.failed}</span>
                </span>
              </motion.span>
            ) : status === 'copied' ? (
              <motion.span
                key={`check-label-${copyCount}`}
                className="flex items-center gap-1.5"
                initial={{ opacity: 0, scale: 0.6 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.8 }}
                transition={spring.fast}
              >
                <span className="flex items-center justify-center">
                  <svg
                    aria-hidden="true"
                    width={14}
                    height={14}
                    viewBox="2 4 20 16"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth={2}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <motion.path
                      d="M6 12L10 16L18 8"
                      initial={{ pathLength: 0 }}
                      animate={{
                        pathLength: 1,
                        transition: tween.fast,
                      }}
                    />
                  </svg>
                </span>
                <span className="select-none inline-grid text-left">
                  <span className="col-start-1 row-start-1 invisible" aria-hidden="true">
                    {sizer}
                  </span>
                  <span className="col-start-1 row-start-1">{labels.copied}</span>
                </span>
              </motion.span>
            ) : (
              <motion.span
                key="copy-label"
                className="flex items-center gap-1.5"
                initial={{ opacity: 0, scale: 0.8 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.8 }}
                transition={spring.fast}
              >
                <span className="flex items-center justify-center">
                  <CopyIcon
                    size={14}
                    strokeWidth={1.5}
                    className="transition-[stroke-width] duration-80 group-hover:stroke-[2]"
                  />
                </span>
                <span className="select-none inline-grid text-left">
                  <span className="col-start-1 row-start-1 invisible" aria-hidden="true">
                    {sizer}
                  </span>
                  <span className="col-start-1 row-start-1">{labels.copy}</span>
                </span>
              </motion.span>
            )}
          </AnimatePresence>
        </span>
      ) : (
        <span
          className={cn(
            'shrink-0 px-1.5 transition-colors duration-80',
            rowPy,
            'text-muted-foreground group-hover:text-foreground',
          )}
        >
          {iconSwitch}
        </span>
      );

    // select-none: a press copies instead of starting a text selection.
    const valueElement = (
      <span
        className={cn(
          'flex-1 min-w-0 text-left text-foreground font-mono select-none truncate',
          sizeClasses.text,
          rowPy,
          align === 'left' ? 'pl-1' : 'pl-0',
        )}
        style={{ fontVariationSettings: fontWeights.normal }}
      >
        <mark className="bg-transparent text-foreground transition-colors duration-80 group-hover:bg-emphasis/20 group-hover:text-foreground">
          {value}
        </mark>
      </span>
    );

    const buttonContent =
      align === 'left' ? (
        <>
          {actionElement}
          {valueElement}
        </>
      ) : (
        <>
          {valueElement}
          {actionElement}
        </>
      );

    const button = (
      <button
        id={buttonId}
        type="button"
        onPointerDown={handlePointerDown}
        onClick={handleCopy}
        disabled={disabled}
        // The name follows the state, so a screen reader hears the result.
        aria-label={
          status === 'copied'
            ? labels.copied
            : status === 'error'
              ? labels.copyFailed
              : label
                ? labels.copy
                : labels.copyToClipboard
        }
        aria-labelledby={label ? `${buttonId} ${labelId}` : undefined}
        className={cn(
          'group flex items-center w-full cursor-pointer transition-all duration-80',
          focusRing,
          shape.input,
        )}
      >
        {buttonContent}
      </button>
    );

    return (
      // biome-ignore lint/a11y/noStaticElementInteractions: hover only re-arms the tooltip; the inner button owns activation.
      <div
        ref={ref}
        className={cn(
          'flex flex-col gap-0.5',
          disabled && 'opacity-50 pointer-events-none',
          className,
        )}
        onMouseEnter={handleMouseEnter}
        onMouseLeave={handleMouseLeave}
        {...props}
      >
        {label && (
          <span
            id={labelId}
            className={cn(
              'text-muted-foreground',
              sizeClasses.text,
              align === 'left' ? 'pl-1' : 'pl-0',
            )}
            style={{ fontVariationSettings: fontWeights.normal }}
          >
            {label}
          </span>
        )}
        {variant === 'icon' ? (
          <Tooltip
            content={
              tooltipState === 'idle'
                ? labels.copyToClipboard
                : status === 'error'
                  ? labels.copyFailed
                  : labels.copied
            }
            delayDuration={500}
            sideOffset={2}
            forceOpen={
              tooltipState === 'copied' ? true : tooltipState === 'suppressed' ? false : undefined
            }
            onOpenChange={handleTooltipOpenChange}
          >
            {button}
          </Tooltip>
        ) : (
          button
        )}
      </div>
    );
  },
);

InputCopy.displayName = 'InputCopy';

export type { InputCopyLabels, InputCopyProps };
export { InputCopy };
export default InputCopy;
