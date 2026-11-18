// A scripted window.corralAnnotate for the overlay's tests: every call is recorded, and each one
// that answers waits until the test answers it.
import type { AnnotateBridge, AnnotateEvent } from '../../../desktop/src/annotate-bridge.ts';

type Answering = 'frame' | 'pick' | 'walk' | 'inspect' | 'consoleFor' | 'preview' | 'submit';

export interface FakeCall {
  name: keyof AnnotateBridge;
  args: unknown[];
  /** Answers a call that waits (frame, pick, walk, inspect, consoleFor, preview, submit). */
  answer(value: unknown): void;
  answered: boolean;
}

export function createFakeAnnotateBridge() {
  const listeners = new Set<(event: AnnotateEvent) => void>();
  const calls: FakeCall[] = [];
  const record = (name: keyof AnnotateBridge, args: unknown[], waits: boolean) => {
    let resolve!: (value: unknown) => void;
    const promise = new Promise<unknown>((done) => {
      resolve = done;
    });
    const call: FakeCall = {
      name,
      args,
      answered: !waits,
      answer(value) {
        call.answered = true;
        resolve(value);
      },
    };
    calls.push(call);
    if (!waits) resolve(undefined);
    return promise;
  };
  const waiting =
    (name: Answering) =>
    (...args: unknown[]) =>
      record(name, args, true) as never;
  const done =
    (name: keyof AnnotateBridge) =>
    (...args: unknown[]) =>
      record(name, args, false) as never;
  const bridge: AnnotateBridge = {
    frame: waiting('frame'),
    pick: waiting('pick'),
    walk: waiting('walk'),
    inspect: waiting('inspect'),
    consoleFor: waiting('consoleFor'),
    preview: waiting('preview'),
    submit: waiting('submit'),
    wheel: (...args: unknown[]) => {
      void record('wheel', args, false);
    },
    release: done('release'),
    cancelSubmit: done('cancelSubmit'),
    tell: done('tell'),
    end: done('end'),
    ended: done('ended'),
    onEvent(callback) {
      listeners.add(callback);
      return () => listeners.delete(callback);
    },
  };
  return {
    bridge,
    calls,
    /** The calls named `name`, oldest first. */
    of: (name: keyof AnnotateBridge) => calls.filter((call) => call.name === name),
    /** The newest call named `name` that is still waiting. */
    waiting: (name: Answering) =>
      calls.filter((call) => call.name === name && !call.answered).at(-1),
    emit(event: AnnotateEvent) {
      for (const listener of listeners) listener(event);
    },
    listeners: () => listeners.size,
  };
}

/** The overlay's animation frames, stepped by the test. */
export function createFrames() {
  const ticks = new Set<() => void>();
  return {
    frames: (tick: () => void) => {
      ticks.add(tick);
      return () => ticks.delete(tick);
    },
    tick() {
      for (const tick of [...ticks]) tick();
    },
    running: () => ticks.size,
  };
}
