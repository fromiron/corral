import { type RefObject, useLayoutEffect, useState } from 'react';

/** Whether the element's own width is at least `min` px (its container, not the window). */
export function useContainerAtLeast(ref: RefObject<HTMLElement | null>, min: number) {
  const [wide, setWide] = useState(false);
  // Measured before paint, so a wide layout does not first show its narrow form.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => setWide(el.clientWidth >= min);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref, min]);
  return wide;
}

/**
 * How many of `steps` (ascending px, a module constant) the element's own width reaches, from one
 * observer: a step changes only when a width crosses one of them.
 */
export function useContainerStep(ref: RefObject<HTMLElement | null>, steps: readonly number[]) {
  const [step, setStep] = useState(0);
  // Measured before paint, as above.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => setStep(steps.filter((min) => el.clientWidth >= min).length);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref, steps]);
  return step;
}
