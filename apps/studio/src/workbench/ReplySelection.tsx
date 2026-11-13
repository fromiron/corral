import {
  REPLY_QUOTE_CONTEXT_MAX,
  REPLY_QUOTE_MAX_LENGTH,
  type TextAttachment,
  type TextAttachmentProvenance,
  textAttachmentKey,
} from '@corral/contracts';
import { createTextAttachment } from '@corral/core';
import { Kbd, KitButton, Popover, PopoverPopup, PopoverTrigger } from '@corral/react/design-kit';
import { Quote } from '@corral/react/icons';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { useTranslations } from 'use-intl';
import { useRegisterCommands } from '../commandRegistry.ts';
import { shortcutLabel } from '../shortcuts.ts';
import { holdPointer } from './ChatView.tsx';
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

export interface ReplyPassage {
  body: HTMLElement;
  source: ReplySource;
  text: string;
  /** Where the toolbar stands: the last line of the passage. */
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
      const rects = copy.getClientRects?.();
      return rects?.length
        ? (rects[rects.length - 1] as DOMRect)
        : (copy.getBoundingClientRect?.() ?? body.getBoundingClientRect());
    },
  };
}

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
  done(result: RevealResult): void;
  handled?: boolean;
}

/** Leads back to a sent quote's passage; the conversation that shows its reply answers. */
export function revealReplyQuote(item: TextAttachment): Promise<RevealResult> {
  return new Promise((done) => {
    const request: RevealRequest = { item, done };
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

/**
 * The conversation's one selection listener and toolbar, and where sent quotes lead back to.
 * `onGoTo` brings the run's row into view by the linked-message path; `onArrived` ends it.
 */
export function ReplySelection({
  target,
  onGoTo,
  onArrived,
}: {
  target: ComposerTarget;
  onGoTo(runId: string): void | Promise<unknown>;
  onArrived?(): void;
}) {
  const t = useTranslations('Composer');
  const [passage, setPassage] = useState<ReplyPassage | null>(null);
  const [dismissed, setDismissed] = useState('');
  const [refused, setRefused] = useState<{ key: string; reason: 'long' | 'failed' } | null>(null);
  // A passage the conversation selected itself (a sent quote's return) shows no toolbar.
  const revealed = useRef<Range | null>(null);
  const latest = useRef({ target, onGoTo, onArrived });
  latest.current = { target, onGoTo, onArrived };
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
      const going = latest.current.onGoTo(source.runId);
      let settled = false;
      const finish = (result: RevealResult) => {
        if (settled) return;
        settled = true;
        observer.disconnect();
        clearTimeout(timer);
        latest.current.onArrived?.();
        request.done(result);
      };
      const look = () => {
        // Only this reply's body: the same words in another reply are not its passage.
        const body = [...document.querySelectorAll<HTMLElement>('[data-reply-body]')].find(
          (node) =>
            node.dataset.runId === source.runId && node.dataset.modelCallId === source.modelCallId,
        );
        if (!body) return;
        const at = findPassage(body.textContent ?? '', source, request.item.text);
        const range = at && rangeIn(body, at.start, at.end);
        if (!range) return finish('missing');
        highlight(range);
        body.focus({ preventScroll: true });
        // The caret at the passage, so reading goes on from there; the toolbar stays away.
        const selection = document.getSelection();
        revealed.current = range;
        selection?.removeAllRanges();
        selection?.addRange(range);
        finish('found');
      };
      // The row may be out of the window and unmounted: wait for it to be drawn.
      const observer = new MutationObserver(look);
      const timer = setTimeout(() => finish('missing'), REVEAL_WAIT_MS);
      // Looked for once the link has moved the conversation, so its own scroll comes first.
      void Promise.resolve(going).then(() =>
        requestAnimationFrame(() =>
          requestAnimationFrame(() => {
            if (settled) return;
            observer.observe(document.body, {
              childList: true,
              subtree: true,
              characterData: true,
            });
            look();
          }),
        ),
      );
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
  return (
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
        side="bottom"
        align="end"
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
  );
}

/**
 * A sent message's quotes, as the chips they were in the request box. A chip leads back to its
 * passage; when the passage is not found, the chip says so and its detail holds the words.
 */
export function SentQuotes({ attachments }: { attachments: TextAttachment[] }) {
  const t = useTranslations('Composer');
  const quotes = attachments.filter((item) => item.provenance?.kind === 'reply');
  if (!quotes.length) return null;
  return (
    <ul aria-label={t('quotes')} className="mt-2 flex flex-wrap gap-1">
      {quotes.map((item) => (
        <SentQuote key={textAttachmentKey(item)} item={item} />
      ))}
    </ul>
  );
}

function SentQuote({ item }: { item: TextAttachment }) {
  const t = useTranslations('Composer');
  const [missing, setMissing] = useState(false);
  const { opening, text } = quoteOpening(item.text);
  const chip = 'flex max-w-full items-center gap-1 rounded-md bg-subtle px-2 py-0.5 text-caption';
  return (
    <li className="flex max-w-full">
      <button
        type="button"
        className={`${chip} cursor-pointer text-left hover:text-foreground`}
        aria-label={t('goToQuote', { text })}
        onClick={async () => setMissing((await revealReplyQuote(item)) === 'missing')}
      >
        <Quote className="size-3 shrink-0 text-muted-foreground" />
        <span className="truncate">{opening}</span>
      </button>
      {missing ? (
        <Popover defaultOpen>
          <PopoverTrigger
            render={
              <button
                type="button"
                className={`${chip} ml-1 cursor-pointer text-muted-foreground`}
              />
            }
          >
            <span role="status">{t('quoteNotFound')}</span>
          </PopoverTrigger>
          <PopoverPopup width="md" padding="compact">
            <blockquote className="max-h-60 overflow-auto whitespace-pre-wrap wrap-anywhere text-body">
              {item.text}
            </blockquote>
          </PopoverPopup>
        </Popover>
      ) : null}
    </li>
  );
}
