import {
  REPLY_QUOTE_CONTEXT_MAX,
  REPLY_QUOTE_MAX_LENGTH,
  type TextAttachment,
  type TextAttachmentProvenance,
  textAttachmentKey,
} from '@corral/contracts';
import { createTextAttachment } from '@corral/core';
import { Kbd, KitButton, Popover, PopoverPopup } from '@corral/react/design-kit';
import { CircleAlert, Quote } from '@corral/react/icons';
import {
  type ReactNode,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { useTranslations } from 'use-intl';
import { useRegisterCommands } from '../commandRegistry.ts';
import { shortcutLabel } from '../shortcuts.ts';
import { holdPointer, placeChatRow } from './ChatView.tsx';
import {
  type AttachmentResult,
  appendComposerAttachment,
  beginAttachmentCapture,
  type ComposerTarget,
} from './context/bridge.ts';
import { quoteOpening } from './TextAttachments.tsx';

// Quoting part of a reply (docs/specs/features/reply-citation.md): a passage chosen in one
// reply's body becomes a chip in the request box, and a sent chip leads back to its passage.

type ReplySource = Extract<TextAttachmentProvenance, { kind: 'reply' }>;

/** The reply text a quote counts in: what the conversation draws of one model call's reply. */
export function ReplyBody({
  runId,
  modelCallId,
  children,
}: {
  runId: string;
  modelCallId: string;
  children: ReactNode;
}) {
  return (
    <div
      data-reply-body=""
      data-run-id={runId}
      data-model-call-id={modelCallId}
      // The passage a sent quote leads back to takes focus here.
      tabIndex={-1}
      className="min-w-0 outline-none"
    >
      {children}
    </div>
  );
}

const bodyOf = (node: Node | null) =>
  (node instanceof Element ? node : node?.parentElement)?.closest<HTMLElement>(
    '[data-reply-body]',
  ) ?? null;

/** Where a point of the body falls in its drawn text, in UTF-16 units. */
function offsetIn(body: HTMLElement, node: Node, offset: number) {
  const range = document.createRange();
  range.selectNodeContents(body);
  range.setEnd(node, offset);
  return range.toString().length;
}

/** The body text around a passage, cut at no surrogate pair. */
function around(text: string, start: number, end: number) {
  let from = Math.max(0, start - REPLY_QUOTE_CONTEXT_MAX);
  if (from > 0 && /[\uDC00-\uDFFF]/.test(text[from] ?? '')) from += 1;
  let to = Math.min(text.length, end + REPLY_QUOTE_CONTEXT_MAX);
  if (to < text.length && /[\uDC00-\uDFFF]/.test(text[to] ?? '')) to -= 1;
  return { prefix: text.slice(from, start), suffix: text.slice(end, to) };
}

/** A rectangle as floating placement reads one. */
const rectOf = (left: number, top: number, width: number, height: number) =>
  ({
    x: left,
    y: top,
    left,
    top,
    width,
    height,
    right: left + width,
    bottom: top + height,
    toJSON: () => ({}),
  }) as DOMRect;

/** The lines a range is drawn on, without the empty boxes of the elements it crosses. */
const linesOf = (range: Range) =>
  [...(range.getClientRects?.() ?? [])].filter((rect) => rect.width > 0 && rect.height > 0);

export interface ReplyPassage {
  body: HTMLElement;
  source: ReplySource;
  text: string;
  /**
   * Where the toolbar stands: from the passage's first line to its last, at the first line's
   * start. It goes over the first line and, with no room there, under the last.
   */
  rect(): DOMRect;
}

/** The passage a selection makes, when it lies in one reply body and holds more than space. */
export function passageOf(selection: Selection | null): ReplyPassage | null {
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return null;
  const range = selection.getRangeAt(0);
  const body = bodyOf(range.startContainer);
  if (!body || bodyOf(range.endContainer) !== body) return null;
  const runId = body.dataset.runId;
  const modelCallId = body.dataset.modelCallId;
  if (!runId || !modelCallId) return null;
  const drawn = body.textContent ?? '';
  const start = offsetIn(body, range.startContainer, range.startOffset);
  const end = offsetIn(body, range.endContainer, range.endOffset);
  const text = drawn.slice(start, end);
  if (end <= start || !text.trim()) return null;
  const copy = range.cloneRange();
  return {
    body,
    text,
    source: { kind: 'reply', runId, modelCallId, start, end, ...around(drawn, start, end) },
    rect: () => {
      const lines = linesOf(copy);
      const first = lines[0];
      const last = lines[lines.length - 1];
      if (!first || !last) return body.getBoundingClientRect();
      return rectOf(first.left, first.top, Math.max(1, first.width), last.bottom - first.top);
    },
  };
}

/**
 * The part of the conversation a person sees: the timeline between its top and the composer
 * lying over its bottom edge, and the column the rows stand in. Null outside a conversation.
 */
function visibleArea(node: Element) {
  const box = node.closest<HTMLElement>('[data-testid="chat-timeline"]');
  if (!box) return null;
  const view = box.getBoundingClientRect();
  const composer = document.querySelector('[data-testid="chat-composer"]')?.getBoundingClientRect();
  const bottom =
    composer && composer.top > view.top && composer.top < view.bottom ? composer.top : view.bottom;
  const column = box.querySelector('[data-chat-window]')?.getBoundingClientRect() ?? view;
  return { box, top: view.top, bottom, left: column.left, width: column.width };
}
const areaRect = (area: NonNullable<ReturnType<typeof visibleArea>>) => ({
  x: area.left,
  y: area.top,
  width: area.width,
  height: Math.max(0, area.bottom - area.top),
});

const passageKey = (passage: ReplyPassage | null) =>
  passage
    ? `${passage.source.runId}\u0000${passage.source.modelCallId}\u0000${passage.source.start}\u0000${passage.source.end}\u0000${passage.text}`
    : '';

/**
 * Where a quote's passage is in a body's text now: at its offsets when the words there are the
 * same, else where its words stand between the same words around them (the occurrence nearest
 * its offsets), else nowhere.
 */
export function findPassage(drawn: string, source: ReplySource, text: string) {
  if (drawn.slice(source.start, source.end) === text)
    return { start: source.start, end: source.end };
  const needle = `${source.prefix}${text}${source.suffix}`;
  let best: number | null = null;
  for (let at = drawn.indexOf(needle); at >= 0; at = drawn.indexOf(needle, at + 1)) {
    const start = at + source.prefix.length;
    if (best === null || Math.abs(start - source.start) < Math.abs(best - source.start))
      best = start;
  }
  return best === null ? null : { start: best, end: best + text.length };
}

/** A range over `[start, end)` of a body's drawn text. */
function rangeIn(body: HTMLElement, start: number, end: number) {
  const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT);
  const range = document.createRange();
  let seen = 0;
  let began = false;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const length = node.textContent?.length ?? 0;
    if (!began && start <= seen + length) {
      range.setStart(node, start - seen);
      began = true;
    }
    if (began && end <= seen + length) {
      range.setEnd(node, end - seen);
      return range;
    }
    seen += length;
  }
  return null;
}

export const REVEAL_REPLY = 'corral:reveal-reply';
export type RevealResult = 'found' | 'missing';
interface RevealRequest {
  item: TextAttachment;
  /** The sent chip asked from: where the conversation comes back to when the passage is gone. */
  from: Element | null;
  done(result: RevealResult): void;
  handled?: boolean;
}

/** Leads back to a sent quote's passage; the conversation that shows its reply answers. */
export function revealReplyQuote(
  item: TextAttachment,
  from: Element | null = null,
): Promise<RevealResult> {
  return new Promise((done) => {
    const request: RevealRequest = { item, from, done };
    window.dispatchEvent(new CustomEvent(REVEAL_REPLY, { detail: request }));
    if (!request.handled) done('missing');
  });
}

const HIGHLIGHT = 'corral-quote';
const HIGHLIGHT_MS = 2000;
/** How long a row brought into view may take to draw its reply before the passage is missing. */
const REVEAL_WAIT_MS = 4000;

/** Marks a passage for a moment, without changing the reply's DOM; no animation either way. */
function highlight(range: Range) {
  const registry = (globalThis.CSS as { highlights?: Map<string, unknown> } | undefined)
    ?.highlights;
  const Highlight = (globalThis as { Highlight?: new (range: Range) => unknown }).Highlight;
  if (!registry || !Highlight) return;
  const mark = new Highlight(range);
  registry.set(HIGHLIGHT, mark);
  setTimeout(() => {
    if (registry.get(HIGHLIGHT) === mark) registry.delete(HIGHLIGHT);
  }, HIGHLIGHT_MS);
}

/** The row an element stands in and where it is on screen: a place to come back to. */
function placeOf(node: Element | null) {
  const row = node?.closest<HTMLElement>('[data-chat-item]');
  const box = row?.closest<HTMLElement>('[data-testid="chat-timeline"]');
  const id = row?.dataset.chatItem;
  if (!row || !box || !id) return null;
  return { id, offset: row.getBoundingClientRect().top - box.getBoundingClientRect().top };
}

// Sent quotes whose passage was not found, by the message they were sent in, and the one whose
// detail stands open. Kept here, so a chip whose row the timeline mounted again shows the same.
const missingQuotes = new Set<string>();
let openDetail: string | null = null;
let quotesVersion = 0;
const quoteListeners = new Set<() => void>();
const quotesChanged = () => {
  quotesVersion += 1;
  for (const listener of quoteListeners) listener();
};
const subscribeQuotes = (listener: () => void) => {
  quoteListeners.add(listener);
  return () => quoteListeners.delete(listener);
};
const readQuotes = () => quotesVersion;

/**
 * The conversation's one selection listener and toolbar, and where sent quotes lead back to.
 * `rowOf` names the timeline row that shows a run; `onPlace` holds a row at an offset from the
 * top of the view, by the linked-message path.
 */
export function ReplySelection({
  target,
  rowOf,
  onPlace = (id, offset) => placeChatRow(target.sessionId, id, offset),
}: {
  target: ComposerTarget;
  rowOf(runId: string): string | undefined;
  onPlace?(id: string, offset: number): void;
}) {
  const t = useTranslations('Composer');
  const [passage, setPassage] = useState<ReplyPassage | null>(null);
  const [dismissed, setDismissed] = useState('');
  const [refused, setRefused] = useState<{ key: string; reason: 'long' | 'failed' } | null>(null);
  // What the live region says: once for each passage not found.
  const [said, setSaid] = useState('');
  // A passage the conversation selected itself (a sent quote's return) shows no toolbar.
  const revealed = useRef<Range | null>(null);
  const latest = useRef({ target, rowOf, onPlace, t });
  latest.current = { target, rowOf, onPlace, t };
  useEffect(() => {
    const held = { current: false };
    let shown = '';
    const read = () => {
      if (held.current) return;
      const selection = document.getSelection();
      const next = passageOf(selection);
      const own = revealed.current;
      const range = selection?.rangeCount ? selection.getRangeAt(0) : null;
      if (
        own &&
        range &&
        range.compareBoundaryPoints(Range.START_TO_START, own) === 0 &&
        range.compareBoundaryPoints(Range.END_TO_END, own) === 0
      )
        return;
      revealed.current = null;
      const key = passageKey(next);
      if (key === shown) return;
      shown = key;
      // A new selection is a new choice: what was put away or quoted before shows again.
      setDismissed('');
      setPassage(next);
    };
    // A drag shows the toolbar where it ends, not at every step on the way.
    const press = (event: PointerEvent) => {
      if (event.button !== 0) return;
      holdPointer(held);
      window.addEventListener('pointerup', () => queueMicrotask(read), {
        once: true,
        capture: true,
      });
    };
    document.addEventListener('selectionchange', read);
    document.addEventListener('pointerdown', press, true);
    return () => {
      document.removeEventListener('selectionchange', read);
      document.removeEventListener('pointerdown', press, true);
    };
  }, []);
  useEffect(() => {
    const reveal = (event: Event) => {
      const request = (event as CustomEvent<RevealRequest>).detail;
      const source = request.item.provenance;
      if (source?.kind !== 'reply') return;
      request.handled = true;
      const { rowOf, onPlace } = latest.current;
      // Only this reply's body: the same words in another reply are not its passage.
      const bodyNow = () =>
        [...document.querySelectorAll<HTMLElement>('[data-reply-body]')].find(
          (node) =>
            node.dataset.runId === source.runId && node.dataset.modelCallId === source.modelCallId,
        );
      let settled = false;
      let origin: ReturnType<typeof placeOf> = null;
      let observer: MutationObserver | null = null;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const finish = (result: RevealResult) => {
        if (settled) return;
        settled = true;
        observer?.disconnect();
        clearTimeout(timer);
        if (result === 'missing') {
          // Gone looking and found nothing: back to where the person asked from.
          if (origin) onPlace(origin.id, origin.offset);
          // Said once, as a change of the live region's words.
          setSaid('');
          requestAnimationFrame(() => setSaid(latest.current.t('quoteNotFound')));
        }
        request.done(result);
      };
      const settle = (body: HTMLElement) => {
        const at = findPassage(body.textContent ?? '', source, request.item.text);
        const range = at && rangeIn(body, at.start, at.end);
        if (!range) return finish('missing');
        // The passage in view, a third of the way down, when it is not there already. The row
        // is held there as a linked row is, so reading goes on from the passage.
        const area = visibleArea(body);
        const row = body.closest<HTMLElement>('[data-chat-item]');
        const line = area && (linesOf(range)[0] ?? range.getBoundingClientRect?.());
        if (
          area &&
          line &&
          row?.dataset.chatItem &&
          (line.top < area.top || line.bottom > area.bottom)
        )
          onPlace(
            row.dataset.chatItem,
            (area.bottom - area.top) / 3 - (line.top - row.getBoundingClientRect().top),
          );
        highlight(range);
        body.focus({ preventScroll: true });
        // The caret at the passage, so reading goes on from there; the toolbar stays away.
        const selection = document.getSelection();
        revealed.current = range;
        selection?.removeAllRanges();
        selection?.addRange(range);
        finish('found');
      };
      // Drawn already: looked for where it is, without moving the conversation first.
      const drawn = bodyNow();
      if (drawn) return settle(drawn);
      // Out of the window: its row is brought in by the link, and looked for once drawn.
      const row = rowOf(source.runId);
      if (!row) return finish('missing');
      origin = placeOf(request.from);
      onPlace(row, 0);
      const look = () => {
        const body = bodyNow();
        if (body) settle(body);
      };
      observer = new MutationObserver(look);
      timer = setTimeout(() => finish('missing'), REVEAL_WAIT_MS);
      requestAnimationFrame(() => {
        if (settled) return;
        observer?.observe(document.body, { childList: true, subtree: true, characterData: true });
        look();
      });
    };
    window.addEventListener(REVEAL_REPLY, reveal);
    return () => window.removeEventListener(REVEAL_REPLY, reveal);
  }, []);
  const key = passageKey(passage);
  const quote = () => {
    if (!passage) return;
    if (passage.text.length > REPLY_QUOTE_MAX_LENGTH) {
      setRefused({ key, reason: 'long' });
      return;
    }
    const attachment = createTextAttachment(
      'quote.txt',
      'text/plain',
      passage.text,
      passage.source,
    );
    const result: AttachmentResult = appendComposerAttachment(
      beginAttachmentCapture(latest.current.target),
      attachment,
    );
    if (!result.ok) {
      setRefused({ key, reason: 'failed' });
      return;
    }
    setDismissed(key);
  };
  const shortcut = shortcutLabel('reply.quote');
  useRegisterCommands(
    'reply-selection',
    passage
      ? [
          {
            id: 'reply:quote',
            title: t('quoteSelection'),
            group: t('groupRequest'),
            shortcutId: 'reply.quote',
            shortcut,
            run: quote,
          },
        ]
      : [],
  );
  const reason = refused?.key === key ? refused.reason : null;
  const open = Boolean(passage) && dismissed !== key;
  const area = passage ? visibleArea(passage.body) : null;
  return (
    <>
      <p role="status" className="sr-only">
        {said}
      </p>
      <Popover
        open={open}
        onOpenChange={(next) => {
          if (!next) setDismissed(key);
        }}
      >
        <PopoverPopup
          anchor={
            passage
              ? { getBoundingClientRect: passage.rect, contextElement: passage.body }
              : undefined
          }
          // Over the passage's first line, where it neither covers the next line to read nor
          // the way the selection grows; under it only when the view has no room above.
          side="top"
          align="start"
          collisionAvoidance={{ side: 'flip', align: 'shift' }}
          {...(area ? { collisionBoundary: areaRect(area) } : {})}
          padding="none"
          // The selection stays where it is; the toolbar takes no focus coming or going.
          initialFocus={false}
          finalFocus={false}
          data-testid="reply-selection"
        >
          <div className="flex flex-col p-1">
            <KitButton variant="ghost" size="compact" leadingIcon={Quote} onClick={quote}>
              {t('quoteSelection')}
              {shortcut ? <Kbd className="ml-2 text-muted-foreground">{shortcut}</Kbd> : null}
            </KitButton>
            {reason ? (
              <p role="alert" className="max-w-64 px-2 py-1 text-caption text-danger">
                {t(reason === 'long' ? 'quoteTooLong' : 'quoteFailed')}
              </p>
            ) : null}
          </div>
        </PopoverPopup>
      </Popover>
    </>
  );
}

/**
 * A sent message's quotes, as the chips they were in the request box. A chip leads back to its
 * passage; when the passage is not found, the chip itself says so and its detail holds the words.
 */
export function SentQuotes({
  attachments,
  owner,
}: {
  attachments: TextAttachment[];
  owner: string;
}) {
  const t = useTranslations('Composer');
  const quotes = attachments.filter((item) => item.provenance?.kind === 'reply');
  if (!quotes.length) return null;
  return (
    <ul aria-label={t('quotes')} className="mt-2 flex flex-wrap gap-1">
      {quotes.map((item) => (
        <SentQuote
          key={textAttachmentKey(item)}
          item={item}
          quote={`${owner}\u0000${textAttachmentKey(item)}`}
        />
      ))}
    </ul>
  );
}

function SentQuote({ item, quote }: { item: TextAttachment; quote: string }) {
  const t = useTranslations('Composer');
  useSyncExternalStore(subscribeQuotes, readQuotes, readQuotes);
  const missing = missingQuotes.has(quote);
  const open = missing && openDetail === quote;
  const chip = useRef<HTMLButtonElement>(null);
  const said = useId();
  const [area, setArea] = useState<ReturnType<typeof areaRect> | null>(null);
  useLayoutEffect(() => {
    const visible = open && chip.current ? visibleArea(chip.current) : null;
    setArea(visible ? areaRect(visible) : null);
  }, [open]);
  const { opening, text } = quoteOpening(item.text);
  const Mark = missing ? CircleAlert : Quote;
  return (
    <li className="flex max-w-full">
      <button
        ref={chip}
        type="button"
        className="flex max-w-full cursor-pointer items-center gap-1 rounded-md bg-subtle px-2 py-0.5 text-left text-caption hover:text-foreground"
        aria-label={t('goToQuote', { text })}
        aria-describedby={missing ? said : undefined}
        onClick={async (event) => {
          const result = await revealReplyQuote(item, event.currentTarget);
          if (result === 'missing') {
            missingQuotes.add(quote);
            openDetail = quote;
          } else {
            missingQuotes.delete(quote);
            if (openDetail === quote) openDetail = null;
          }
          quotesChanged();
        }}
      >
        <Mark className={`size-3 shrink-0 ${missing ? 'text-warning' : 'text-muted-foreground'}`} />
        <span className="truncate">{opening}</span>
      </button>
      {missing ? (
        <span id={said} hidden>
          {t('quoteNotFound')}
        </span>
      ) : null}
      <Popover
        open={open}
        onOpenChange={(next) => {
          if (next || openDetail !== quote) return;
          openDetail = null;
          quotesChanged();
        }}
      >
        <PopoverPopup
          anchor={chip}
          width="md"
          padding="compact"
          collisionAvoidance={{ side: 'flip', align: 'shift' }}
          {...(area ? { collisionBoundary: area } : {})}
          initialFocus={false}
          finalFocus={chip}
          data-testid="quote-detail"
        >
          <p className="text-caption text-muted-foreground">{t('quoteNotFound')}</p>
          <blockquote className="mt-1 max-h-60 overflow-auto whitespace-pre-wrap wrap-anywhere text-body">
            {item.text}
          </blockquote>
        </PopoverPopup>
      </Popover>
    </li>
  );
}
