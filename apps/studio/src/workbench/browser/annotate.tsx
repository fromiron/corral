// The app page's side of browser annotation (features/browser-annotate.md): the mode per tab as
// the desktop says it, the 주석 button's and the shortcut's toggle, the overlay's context sent
// whole on every change, the overlay's messages, and what the app page says politely. The
// overlay (apps/studio/src/annotate/) draws the notes; the composer's draft stays the composer's,
// reached through the port it publishes.
import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { useTranslations } from 'use-intl';
import type { BrowserBridge, BrowserEvent } from '../../../../desktop/src/browser-bridge.ts';
import type { AnnotateContext, AnnotateMessage } from '../../annotate/protocol.ts';
import { useLocale } from '../../locale.tsx';
import { usePreferences } from '../preferences.ts';
import { appliedAppearance } from '../themes/appearance.ts';
import { paletteTokens } from '../themes/tokens.ts';

/** "모아 두기", one switch on this device (browser-annotate.md 계약: 기억). */
export const COLLECT_KEY = 'corral:annotate-collect';
const readCollect = () => {
  try {
    return globalThis.localStorage?.getItem(COLLECT_KEY) === 'true';
  } catch {
    return false;
  }
};
const writeCollect = (on: boolean) => {
  try {
    globalThis.localStorage?.setItem(COLLECT_KEY, on ? 'true' : 'false');
  } catch {}
};

/** What the composer's draft says now, for the overlay's context. */
export interface ComposerAnnotateState {
  /** Text attachments and images in the draft, against their limits. */
  textAttachments: number;
  images: number;
  /** A note sent now takes an image: the send key would start a new or next request. */
  imagesNow: boolean;
  /** The collected notes in the draft's chips, by pick. */
  markers: { pickId: string; n: number }[];
}
const IDLE_COMPOSER: ComposerAnnotateState = {
  textAttachments: 0,
  images: 0,
  imagesNow: true,
  markers: [],
};

/** The composer's side, published by the mounted composer of the conversation. */
export interface ComposerAnnotatePort {
  state(): ComposerAnnotateState;
}

/** One conversation's composer port, held while its composer is mounted. */
export class ComposerAnnotateRegistry {
  private port: ComposerAnnotatePort | null = null;
  private readonly listeners = new Set<() => void>();
  private version = 0;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  snapshot = () => this.version;
  get(): ComposerAnnotatePort | null {
    return this.port;
  }
  set(port: ComposerAnnotatePort | null) {
    this.port = port;
    this.changed();
  }
  /** The composer's draft or intent changed. */
  changed() {
    this.version += 1;
    for (const listener of [...this.listeners]) listener();
  }
}

export const ComposerAnnotateContext = createContext<ComposerAnnotateRegistry | null>(null);

/**
 * The composer publishes its port and says when what it reports changes (`key`: anything that
 * changes the state it reports). Nothing happens without a registry (no browser tab).
 */
export function usePublishComposerAnnotate(port: ComposerAnnotatePort, key: string) {
  const registry = useContext(ComposerAnnotateContext);
  const latest = useRef(port);
  latest.current = port;
  useEffect(() => {
    if (!registry) return;
    registry.set({ state: () => latest.current.state() });
    return () => registry.set(null);
  }, [registry]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `key` is the change signal.
  useEffect(() => {
    registry?.changed();
  }, [registry, key]);
}

/** The annotation mode per tab and the app page's polite announcements. */
export class BrowserAnnotations {
  private readonly on = new Set<string>();
  private readonly listeners = new Set<() => void>();
  private said: { text: string; n: number } = { text: '', n: 0 };
  private version = 0;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  snapshot = () => this.version;
  isOn(tabId: string): boolean {
    return this.on.has(tabId);
  }
  /** The tabs in the mode now. */
  tabs(): string[] {
    return [...this.on];
  }
  set(tabId: string, on: boolean) {
    if (on === this.on.has(tabId)) return;
    if (on) this.on.add(tabId);
    else this.on.delete(tabId);
    this.changed();
  }
  clear() {
    if (this.on.size === 0) return;
    this.on.clear();
    this.changed();
  }
  /** Says something politely; the same words again are said again. */
  announce(text: string) {
    this.said = { text, n: this.said.n + 1 };
    this.changed();
  }
  announcement() {
    return this.said;
  }
  private changed() {
    this.version += 1;
    for (const listener of [...this.listeners]) listener();
  }
}

export interface BrowserAnnotate {
  readonly annotations: BrowserAnnotations;
  /** Turns the tab's mode on or off; the shortcut's toggle says so politely, the button's not. */
  toggle(tabId: string, via: 'button' | 'shortcut'): void;
}

const BrowserAnnotateContext = createContext<BrowserAnnotate | null>(null);

export function BrowserAnnotateProvider({
  value,
  children,
}: {
  value: BrowserAnnotate | null;
  children: ReactNode;
}) {
  return (
    <BrowserAnnotateContext.Provider value={value}>{children}</BrowserAnnotateContext.Provider>
  );
}

export function useBrowserAnnotateContext(): BrowserAnnotate | null {
  return useContext(BrowserAnnotateContext);
}

const noSubscribe = () => () => {};
const off = () => false;

/** Whether the tab is in the annotation mode now. */
export function useAnnotating(tabId: string): boolean {
  const annotate = useContext(BrowserAnnotateContext);
  return useSyncExternalStore(
    annotate?.annotations.subscribe ?? noSubscribe,
    () => annotate?.annotations.isOn(tabId) ?? false,
    off,
  );
}

/** A shortcut pressed in a page, which the desktop handed back with its tab. */
export const ANNOTATE_SHORTCUT = 'corral:browser-annotate';

/** What the overlay may tell the app page; anything else is dropped. */
function overlayMessage(message: unknown): AnnotateMessage | null {
  if (!message || typeof message !== 'object') return null;
  const value = message as Record<string, unknown>;
  if (value.type === 'collect' && typeof value.on === 'boolean')
    return { type: 'collect', on: value.on };
  if (value.type === 'note-closed' && typeof value.noteId === 'string')
    return { type: 'note-closed', noteId: value.noteId };
  return null;
}

export interface BrowserAnnotateInput {
  bridge: BrowserBridge | null | undefined;
  sessionId: string;
  /** Whether a tab is this conversation's. */
  owns: (tabId: string) => boolean;
  composer: ComposerAnnotateRegistry;
}

/**
 * The conversation's annotation over the desktop's bridge: one subscription for its events, the
 * context sent whole to every tab in the mode whenever any part of it changes.
 */
export function useBrowserAnnotate(input: BrowserAnnotateInput): BrowserAnnotate | null {
  const { bridge, sessionId, composer } = input;
  const t = useTranslations('Browser');
  const latest = useRef(input);
  latest.current = input;
  const toggleRef = useRef<BrowserAnnotate['toggle']>(() => {});
  const [stable] = useState<BrowserAnnotate>(() => ({
    annotations: new BrowserAnnotations(),
    toggle: (tabId, via) => toggleRef.current(tabId, via),
  }));
  const { annotations } = stable;
  const [collect, setCollect] = useState(readCollect);
  const { locale } = useLocale();
  const { density, sendKey } = usePreferences();
  const appearance = useSyncExternalStore(
    appliedAppearance.subscribe,
    appliedAppearance.getState,
    appliedAppearance.getState,
  );
  const composerVersion = useSyncExternalStore(
    composer.subscribe,
    composer.snapshot,
    composer.snapshot,
  );
  const mode = useSyncExternalStore(
    annotations.subscribe,
    annotations.snapshot,
    annotations.snapshot,
  );

  // Leaving the conversation: its tabs' modes are over (main ends them as their pages go).
  // biome-ignore lint/correctness/useExhaustiveDependencies: A new conversation starts with no mode on.
  useEffect(() => () => annotations.clear(), [annotations, sessionId]);

  useEffect(() => {
    if (!bridge) return;
    return bridge.onEvent((event: BrowserEvent) => {
      const now = latest.current;
      if (event.type === 'annotate') {
        if (now.owns(event.tabId)) annotations.set(event.tabId, event.on);
        return;
      }
      if (event.type === 'annotate-message') {
        if (!now.owns(event.tabId)) return;
        const message = overlayMessage(event.message);
        if (message?.type === 'collect') {
          writeCollect(message.on);
          setCollect(message.on);
        }
      }
    });
  }, [bridge, annotations]);

  // The context, whole, to every tab in the mode, whenever any part of it changes.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `mode` and `composerVersion` are the change signals of their stores.
  useEffect(() => {
    if (!bridge) return;
    const tabs = annotations.tabs();
    if (tabs.length === 0) return;
    const { palette, dark } = appearance;
    const draft = composer.get()?.state() ?? IDLE_COMPOSER;
    const context: AnnotateContext = {
      locale,
      theme: { dark, tokens: palette ? { ...paletteTokens(palette) } : null },
      density,
      sendKey,
      collect,
      draft: { textAttachments: draft.textAttachments, images: draft.images },
      imagesNow: draft.imagesNow,
      markers: draft.markers,
    };
    for (const tabId of tabs) void bridge.annotateContext(tabId, context).catch(() => {});
  }, [bridge, annotations, mode, locale, appearance, density, sendKey, collect, composerVersion]);

  // A shortcut pressed in a page (the desktop hands it back with its tab).
  useEffect(() => {
    const onShortcut = (event: Event) => {
      const tabId = (event as CustomEvent<{ tabId?: unknown }>).detail?.tabId;
      if (typeof tabId === 'string' && latest.current.owns(tabId))
        toggleRef.current(tabId, 'shortcut');
    };
    window.addEventListener(ANNOTATE_SHORTCUT, onShortcut);
    return () => window.removeEventListener(ANNOTATE_SHORTCUT, onShortcut);
  }, []);

  if (!bridge) return null;
  toggleRef.current = (tabId, via) => {
    const on = !annotations.isOn(tabId);
    void bridge.annotate(tabId, on).then(
      (done) => {
        if (done && via === 'shortcut') annotations.announce(t(on ? 'annotateOn' : 'annotateOff'));
      },
      () => {},
    );
  };
  return stable;
}

/** The app page's polite announcements of annotation (the overlay says its own). */
export function BrowserAnnouncer({ annotate }: { annotate: BrowserAnnotate | null }) {
  const said = useSyncExternalStore(
    annotate?.annotations.subscribe ?? noSubscribe,
    () => annotate?.annotations.announcement() ?? null,
    () => null,
  );
  return (
    <p className="sr-only" aria-live="polite" aria-atomic="true" data-browser-announcer="">
      {said?.text ?? ''}
    </p>
  );
}
