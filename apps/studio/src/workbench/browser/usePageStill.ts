// The swap of a page's live view for a picture of it while the app covers it (features/
// browser-tab.md 앱 화면과 겹칠 때), in the desktop's two steps: `still()` takes a picture with
// the view still live; once the picture is painted, `freeze()` hides the view; `thaw()` shows it
// again. While the annotation mode is on, the picture carries the overlay's too, painted over
// the page's; freeze and thaw cover both views. One step at a time, each checking what is
// wanted now, so a cover that ends before its picture comes never hides the view, and a hidden
// view is always shown again. A picture the desktop cannot take (null), or a freeze a newer step
// won (false), leaves the view live.
import { type RefObject, useEffect, useRef, useState } from 'react';
import type { BrowserBridge, BrowserStill } from '../../../../desktop/src/browser-bridge.ts';
import { pageHoldSwitch, watchCover } from './overlap.ts';

export interface PageStill {
  /** The picture to lay over the place, in the place's CSS pixels when it was taken. */
  picture: (BrowserStill & { box: { width: number; height: number } }) | null;
  /** The view is not live and on screen: being swapped, swapped, or being swapped back. */
  still: boolean;
}

/** Two frames: the picture is on screen before the view goes. */
const painted = () =>
  new Promise<void>((resolve) => {
    if (typeof requestAnimationFrame !== 'function') {
      window.setTimeout(resolve, 32);
      return;
    }
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  });

export function usePageStill(
  bridge: BrowserBridge | null | undefined,
  tabId: string,
  /** The tab is on screen with a live page. */
  active: boolean,
  place: RefObject<HTMLElement | null>,
): PageStill {
  const [picture, setPicture] = useState<PageStill['picture']>(null);
  const [still, setStill] = useState(false);
  const covered = useRef(false);
  const run = useRef<(() => void) | null>(null);

  useEffect(() => {
    if (!bridge) return;
    let frozen = false;
    // The desktop gave no picture, or a newer step won: the view stays live until uncovered.
    let keptLive = false;
    let running = false;
    let picturedLast: PageStill['picture'] = null;
    const show = (next: PageStill['picture']) => {
      picturedLast = next;
      setPicture(next);
    };
    const reconcile = async () => {
      if (running) return;
      running = true;
      try {
        for (;;) {
          const want = covered.current;
          if (want && !frozen && !keptLive) {
            setStill(true);
            const element = place.current;
            const rect = element?.getBoundingClientRect();
            const taken = await bridge.still(tabId).catch(() => null);
            if (!covered.current) continue;
            if (!taken) {
              keptLive = true;
              setStill(false);
              continue;
            }
            show({ ...taken, box: { width: rect?.width ?? 0, height: rect?.height ?? 0 } });
            await painted();
            if (!covered.current) continue;
            const hidden = await bridge.freeze(tabId, taken.stillId).catch(() => false);
            if (!hidden) {
              keptLive = true;
              show(null);
              setStill(false);
              continue;
            }
            frozen = true;
            continue;
          }
          if (!want) {
            keptLive = false;
            if (frozen) {
              frozen = false;
              await bridge.thaw(tabId).catch(() => {});
              continue;
            }
            if (picturedLast) show(null);
            setStill(false);
          }
          return;
        }
      } finally {
        running = false;
      }
    };
    run.current = () => void reconcile();
    return () => {
      run.current = null;
      // Leaving with the view hidden: show it again, so the tab comes back live.
      covered.current = false;
      if (frozen) void bridge.thaw(tabId).catch(() => {});
      frozen = false;
    };
  }, [bridge, tabId, place]);

  useEffect(() => {
    const element = place.current;
    if (!bridge || !active || !element) {
      if (covered.current) {
        covered.current = false;
        run.current?.();
      }
      return;
    }
    const stop = watchCover(element, (now) => {
      covered.current = now;
      run.current?.();
    });
    return () => {
      stop();
      if (covered.current) {
        covered.current = false;
        run.current?.();
      }
    };
  }, [bridge, active, place]);

  return { picture, still };
}

/**
 * An on/off hold over every page for a host's own signal (a splitter or a tab being dragged),
 * let go when the host unmounts mid-drag.
 */
export function usePageHoldSwitch(): (on: boolean) => void {
  const [hold] = useState(pageHoldSwitch);
  useEffect(() => () => hold(false), [hold]);
  return hold;
}
