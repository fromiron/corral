import { useCallback, useState } from 'react';

/**
 * State that a parent may control. Pass the controlled `value` (or
 * `undefined` to let the hook own it), the uncontrolled starting value, and
 * the change callback; get back the current value and a setter that updates
 * internal state only when uncontrolled and always calls `onChange`.
 *
 *   const [open, setOpen] = useControllable(openProp, defaultOpen ?? false, onOpenChange);
 */
export function useControllable<T>(
  value: T | undefined,
  defaultValue: T,
  onChange?: (next: T) => void,
): [T, (next: T) => void] {
  const [inner, setInner] = useState(defaultValue);
  const current = value !== undefined ? value : inner;
  const set = useCallback(
    (next: T) => {
      if (value === undefined) setInner(next);
      onChange?.(next);
    },
    [value, onChange],
  );
  return [current, set];
}
