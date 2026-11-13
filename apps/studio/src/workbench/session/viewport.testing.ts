import { act } from 'react';
import { vi } from 'vitest';

/**
 * IntersectionObserver for jsdom tests, as the conversation's observers (the tray's placement,
 * the activity bar's visible labels) see the screen: every observed element is in view until
 * `scroll` says otherwise, and `scroll` reports each element again, as a scroll would.
 */
export function stubViewport() {
  const observers = new Set<Observer>();
  let shown: (element: Element) => boolean = () => true;
  class Observer {
    readonly targets = new Set<Element>();
    private readonly callback: IntersectionObserverCallback;
    constructor(callback: IntersectionObserverCallback) {
      this.callback = callback;
      observers.add(this);
    }
    observe(element: Element) {
      this.targets.add(element);
      this.report([element]);
    }
    unobserve(element: Element) {
      this.targets.delete(element);
    }
    disconnect() {
      this.targets.clear();
      observers.delete(this);
    }
    takeRecords() {
      return [];
    }
    report(elements: Iterable<Element>) {
      const entries = [...elements].map((target) => {
        const inView = shown(target);
        return {
          target,
          isIntersecting: inView,
          intersectionRect: { height: inView ? 20 : 0 },
          boundingClientRect: { height: 20 },
          rootBounds: { height: 600 },
        } as unknown as IntersectionObserverEntry;
      });
      if (entries.length) this.callback(entries, this as unknown as IntersectionObserver);
    }
  }
  vi.stubGlobal('IntersectionObserver', Observer);
  return {
    /** Puts on screen only what `inView` accepts, and tells every observer. */
    scroll: async (inView: (element: Element) => boolean) => {
      shown = inView;
      await act(async () => {
        for (const observer of observers) observer.report([...observer.targets]);
      });
    },
  };
}
