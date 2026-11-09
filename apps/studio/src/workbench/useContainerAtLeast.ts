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
