// @vitest-environment jsdom
import { act, useRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useVisibleLabels } from './useActivity.ts';

// One observer stands in for the browser's: it reports only when told to.
type Observer = { callback: IntersectionObserverCallback; watched: Set<Element> };
let observers: Observer[] = [];
let root: Root;
let host: HTMLElement;
let timeline: HTMLElement;
const painted: string[][] = [];

function Labels() {
  const anchor = useRef<HTMLSpanElement>(null);
  const visible = useVisibleLabels(anchor);
  return <span ref={anchor}>{[...visible].sort().join(',')}</span>;
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  observers = [];
  painted.length = 0;
  vi.stubGlobal(
    'IntersectionObserver',
    class {
      private readonly self: Observer;
      constructor(callback: IntersectionObserverCallback) {
        this.self = { callback, watched: new Set() };
        observers.push(this.self);
      }
      observe(element: Element) {
        this.self.watched.add(element);
      }
      unobserve(element: Element) {
        this.self.watched.delete(element);
      }
      disconnect() {
        this.self.watched.clear();
      }
      takeRecords() {
        return [];
      }
    },
  );
  host = document.createElement('div');
  host.setAttribute('data-chat-view', '');
  timeline = document.createElement('div');
  timeline.setAttribute('data-testid', 'chat-timeline');
  const bar = document.createElement('div');
  host.append(timeline, bar);
  document.body.append(host);
  root = createRoot(bar);
  act(() => root.render(<Labels />));
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

const said = () => host.querySelector('span')?.textContent ?? '';
const row = (label: string) => {
  const element = document.createElement('div');
  element.setAttribute('data-presence-label', label);
  return element;
};
/** The observer measures `element`: on screen or not. */
const measure = (element: Element, onScreen: boolean) =>
  act(() => {
    const observer = observers.at(-1) as Observer;
    observer.callback(
      [
        {
          target: element,
          isIntersecting: onScreen,
          intersectionRect: { height: onScreen ? 20 : 0 } as DOMRectReadOnly,
        } as IntersectionObserverEntry,
      ],
      {} as IntersectionObserver,
    );
  });
/** A row comes in the timeline; what the hook says by the end of that task, before any frame. */
const arrive = async (element: Element) => {
  await act(async () => {
    timeline.append(element);
    // The mutation's callback runs as a microtask of the task that added the row.
    await Promise.resolve();
    painted.push([said()]);
  });
};

it('counts a row that came and is not measured yet as on screen, before the frame', async () => {
  const run = row('run:run_1');
  await arrive(run);
  expect(painted.at(-1)).toEqual(['run:run_1']);
  expect(observers.at(-1)?.watched.has(run)).toBe(true);
});

it('says a row is off screen once the observer says so, and on screen again when it does', async () => {
  const run = row('run:run_1');
  await arrive(run);
  measure(run, false);
  expect(said()).toBe('');
  measure(run, true);
  expect(said()).toBe('run:run_1');
});

it('drops a row that left the timeline, measured or not', async () => {
  const run = row('run:run_1');
  const role = row('execution:exec_1');
  await arrive(run);
  await arrive(role);
  measure(run, true);
  expect(said()).toBe('execution:exec_1,run:run_1');
  await act(async () => {
    run.remove();
    role.remove();
    await Promise.resolve();
  });
  expect(said()).toBe('');
});

it('never counts a label that is not in the timeline', async () => {
  const elsewhere = row('run:run_2');
  await act(async () => {
    host.append(elsewhere);
    await Promise.resolve();
  });
  expect(said()).toBe('');
});
