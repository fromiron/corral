// @vitest-environment jsdom
import type { TextAttachment } from '@corral/contracts';
import { createTextAttachment } from '@corral/core';
import { act, type ReactNode, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { IntlProvider } from 'use-intl';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import messages from '../../../../packages/react/src/messages/en.json' with { type: 'json' };
import { runShortcut } from '../commandRegistry.ts';
import { type AttachmentRequest, COMPOSER_ATTACH } from './context/bridge.ts';
import { findPassage, ReplyBody, ReplySelection, SentQuotes } from './ReplySelection.tsx';

// docs/specs/features/reply-citation.md: a passage chosen in one reply becomes a chip through
// the composer's capture path; a sent chip leads back to its passage in that reply alone.

const REPLY = 'The quick brown fox jumps over the lazy dog.';
const target = { hostId: 'host', projectId: 'project', sessionId: 'session' };
const attached: AttachmentRequest[] = [];
const accept = (event: Event) => {
  const request = (event as CustomEvent<AttachmentRequest>).detail;
  attached.push(request);
  request.result = { ok: true };
};
const cleanup: (() => Promise<void>)[] = [];
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  attached.length = 0;
  window.addEventListener(COMPOSER_ATTACH, accept);
});
afterEach(async () => {
  for (const dispose of cleanup.splice(0)) await dispose();
  window.removeEventListener(COMPOSER_ATTACH, accept);
  document.getSelection()?.removeAllRanges();
  vi.unstubAllGlobals();
});

async function mount(
  children: ReactNode,
  {
    onPlace = vi.fn(),
    rowOf = (runId: string) => (runId === 'run_a' ? 'entry_reply' : undefined),
  }: {
    onPlace?: (id: string, offset: number) => void;
    rowOf?: (runId: string) => string | undefined;
  } = {},
) {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  await act(async () =>
    root.render(
      <IntlProvider locale="en" messages={messages} timeZone="UTC">
        <ReplySelection target={target} rowOf={rowOf} onPlace={onPlace} />
        {children}
      </IntlProvider>,
    ),
  );
  cleanup.push(async () => {
    await act(async () => root.unmount());
    container.remove();
  });
  return container;
}

const replies = (first = REPLY, second = 'Another reply entirely.') => (
  <>
    <ReplyBody runId="run_a" modelCallId="call_a">
      <p data-testid="first">{first}</p>
    </ReplyBody>
    <ReplyBody runId="run_b" modelCallId="call_b">
      <p data-testid="second">{second}</p>
    </ReplyBody>
    <p data-testid="outside">Outside any reply.</p>
    <p data-testid="space">{'     '}</p>
  </>
);
const text = (testId: string) =>
  document.querySelector(`[data-testid="${testId}"]`)?.firstChild as Text;

/** Selects from one text node offset to another, as a person's drag or keys do. */
async function select(from: Text, start: number, to: Text, end: number) {
  const range = document.createRange();
  range.setStart(from, start);
  range.setEnd(to, end);
  const selection = document.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
  await act(async () => document.dispatchEvent(new Event('selectionchange')));
}
const toolbar = () => document.querySelector('[data-testid="reply-selection"]');
const quoteButton = () =>
  [...(toolbar()?.querySelectorAll('button') ?? [])].find((button) =>
    button.textContent?.startsWith(messages.Composer.quoteSelection),
  );

it('a passage in one reply shows the toolbar, and its button makes the quote chip', async () => {
  await mount(replies());
  await select(text('first'), 4, text('first'), 15);
  expect(toolbar()).not.toBeNull();
  expect(toolbar()?.querySelector('kbd')?.textContent).toBe('Alt+Q');
  await act(async () => quoteButton()?.click());
  expect(attached).toHaveLength(1);
  expect(attached[0]?.capture.target).toEqual(target);
  expect(attached[0]?.attachment.text).toBe('quick brown');
  expect(attached[0]?.attachment.provenance).toEqual({
    kind: 'reply',
    runId: 'run_a',
    modelCallId: 'call_a',
    start: 4,
    end: 15,
    prefix: 'The ',
    suffix: ' fox jumps over the lazy dog.',
  });
  // Quoted: the toolbar goes.
  expect(toolbar()).toBeNull();
});

it('takes at most 32 characters of context on each side', async () => {
  const long = `${'a'.repeat(40)} chosen ${'b'.repeat(40)}`;
  await mount(replies(long));
  await select(text('first'), 41, text('first'), 47);
  await act(async () => quoteButton()?.click());
  expect(attached[0]?.attachment.provenance).toMatchObject({
    start: 41,
    end: 47,
    prefix: `${'a'.repeat(31)} `,
    suffix: ` ${'b'.repeat(31)}`,
  });
});

it.each([
  ['across two replies', () => [text('first'), 4, text('second'), 7] as const],
  ['from a reply out of it', () => [text('first'), 4, text('outside'), 7] as const],
  ['outside any reply', () => [text('outside'), 0, text('outside'), 7] as const],
  ['of space alone', () => [text('first'), 3, text('first'), 4] as const],
])('a selection %s shows no toolbar and quotes nothing', async (_name, range) => {
  await mount(replies());
  const [from, start, to, end] = range();
  await select(from, start, to, end);
  expect(toolbar()).toBeNull();
  expect(runShortcut('reply.quote')).toBe(false);
  expect(attached).toHaveLength(0);
});

it('Escape and letting go of the selection put the toolbar away', async () => {
  await mount(replies());
  await select(text('first'), 4, text('first'), 15);
  expect(toolbar()).not.toBeNull();
  await act(async () =>
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })),
  );
  expect(toolbar()).toBeNull();
  await select(text('first'), 16, text('first'), 19);
  expect(toolbar()).not.toBeNull();
  document.getSelection()?.removeAllRanges();
  await act(async () => document.dispatchEvent(new Event('selectionchange')));
  expect(toolbar()).toBeNull();
  // Put away, then chosen again by a new selection: the toolbar is back.
  await select(text('first'), 16, text('first'), 19);
  expect(toolbar()).not.toBeNull();
  await act(async () =>
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })),
  );
  await select(text('first'), 16, text('first'), 17);
  await select(text('first'), 16, text('first'), 19);
  expect(toolbar()).not.toBeNull();
});

it('the shortcut quotes the chosen passage, and does nothing with none chosen', async () => {
  await mount(replies());
  expect(runShortcut('reply.quote')).toBe(false);
  await select(text('first'), 16, text('first'), 19);
  await act(async () => {
    expect(runShortcut('reply.quote')).toBe(true);
  });
  expect(attached[0]?.attachment.text).toBe('fox');
});

it('refuses a passage over 8,000 characters with the reason, and takes one of 8,000', async () => {
  await mount(replies(`${'x'.repeat(8_001)}`));
  await select(text('first'), 0, text('first'), 8_001);
  await act(async () => quoteButton()?.click());
  expect(attached).toHaveLength(0);
  expect(toolbar()?.querySelector('[role="alert"]')?.textContent).toBe(
    messages.Composer.quoteTooLong,
  );
  await select(text('first'), 0, text('first'), 8_000);
  expect(toolbar()?.querySelector('[role="alert"]')).toBeNull();
  await act(async () => quoteButton()?.click());
  expect(attached).toHaveLength(1);
});

// The way back from a sent quote.
const sent = (quoted = 'quick brown', start = 4, end = 15) =>
  createTextAttachment('quote.txt', 'text/plain', quoted, {
    kind: 'reply',
    runId: 'run_a',
    modelCallId: 'call_a',
    start,
    end,
    prefix: 'The ',
    suffix: ' fox jumps over the lazy dog.',
  });
// Each test sends its quotes in a message of its own: what a chip said stays with its message.
let messagesSent = 0;
const sentIn = (item: TextAttachment, owner = `entry_${++messagesSent}`) => (
  <SentQuotes attachments={[item]} owner={owner} />
);
/** The conversation's timeline: the reply's row and the row of the message that quoted it. */
const timeline = (reply: ReactNode, quotes: ReactNode) => (
  <section data-testid="chat-timeline">
    <ol data-chat-window>
      <li data-chat-item="entry_reply">{reply}</li>
      <li data-chat-item="entry_sent">{quotes}</li>
    </ol>
  </section>
);
const chips = () =>
  [...document.querySelectorAll('button')].filter((button) =>
    button.getAttribute('aria-label')?.startsWith('Go to the quoted passage'),
  );
const chip = () => chips()[0];
const detail = () => document.querySelector('[data-testid="quote-detail"]');
const said = () => document.querySelector('[role="status"]')?.textContent ?? '';
async function goBack() {
  await act(async () => chip()?.click());
  await vi.waitFor(() => {
    if (!document.activeElement?.hasAttribute('data-reply-body') && !description())
      throw new Error('not yet');
  });
  // The live region speaks a frame after the change.
  await act(async () => new Promise((resolve) => requestAnimationFrame(() => resolve(undefined))));
}
const description = () => {
  const id = chip()?.getAttribute('aria-describedby');
  return id ? (document.getElementById(id)?.textContent ?? '') : '';
};
const bodyOf = (testId: string) =>
  document.querySelector(`[data-testid="${testId}"]`)?.closest('[data-reply-body]');

it('a drawn reply’s passage is found where it is, takes focus, and the view is left alone', async () => {
  const onPlace = vi.fn();
  await mount(
    <>
      {replies()}
      {sentIn(sent())}
    </>,
    { onPlace },
  );
  await goBack();
  expect(document.activeElement).toBe(bodyOf('first'));
  expect(document.getSelection()?.toString()).toBe('quick brown');
  // The conversation's own selection of the passage shows no toolbar.
  expect(toolbar()).toBeNull();
  expect(onPlace).not.toHaveBeenCalled();
  expect(description()).toBe('');
  expect(detail()).toBeNull();
});

it('finds the passage by the words around it when its offsets moved', async () => {
  await mount(
    <>
      {replies(`Edited first. ${REPLY}`)}
      {sentIn(sent())}
    </>,
  );
  await goBack();
  expect(document.activeElement).toBe(bodyOf('first'));
  const range = document.getSelection()?.getRangeAt(0);
  expect(range?.toString()).toBe('quick brown');
  expect(range?.startOffset).toBe(18);
});

it('a passage gone from a drawn reply: the chip itself says so, its detail holds the words, the view stays', async () => {
  const onPlace = vi.fn();
  await mount(
    <>
      {replies('Nothing like the quote is left here.')}
      {sentIn(sent())}
    </>,
    {
      onPlace,
    },
  );
  await goBack();
  expect(onPlace).not.toHaveBeenCalled();
  // One chip, now saying the passage was not found, by name and by description.
  expect(chips()).toHaveLength(1);
  expect(chip()?.getAttribute('aria-label')).toBe('Go to the quoted passage: quick brown');
  expect(description()).toBe(messages.Composer.quoteNotFound);
  expect(detail()?.textContent).toContain(messages.Composer.quoteNotFound);
  expect(detail()?.querySelector('blockquote')?.textContent).toBe('quick brown');
  // Said once by the live region.
  expect(said()).toBe(messages.Composer.quoteNotFound);
  expect(document.getSelection()?.toString()).toBe('');
  // Escape closes the detail; the chip goes on saying it.
  await act(async () =>
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })),
  );
  await vi.waitFor(() => expect(detail()).toBeNull());
  expect(description()).toBe(messages.Composer.quoteNotFound);
});

it('never shows the same words in another reply in place of the passage', async () => {
  await mount(
    <>
      {replies('The first reply changed.', REPLY)}
      {sentIn(sent())}
    </>,
  );
  await goBack();
  expect(description()).toBe(messages.Composer.quoteNotFound);
  expect(document.activeElement).not.toBe(bodyOf('second'));
  expect(document.getSelection()?.toString()).toBe('');
});

/** A reply whose row is out of the window, drawn once the conversation places its row. */
function later(first = REPLY) {
  const shown = { show: () => {} };
  function Later() {
    const [drawn, setDrawn] = useState(false);
    shown.show = () => setDrawn(true);
    return drawn ? (
      <ReplyBody runId="run_a" modelCallId="call_a">
        <p data-testid="first">{first}</p>
      </ReplyBody>
    ) : null;
  }
  const onPlace = vi.fn((id: string) => {
    if (id === 'entry_reply') setTimeout(() => act(() => shown.show()), 50);
  });
  return { Later, onPlace };
}

it('brings in a reply whose row was out of the window, and finds its passage once drawn', async () => {
  const { Later, onPlace } = later();
  await mount(timeline(<Later />, sentIn(sent())), { onPlace });
  await goBack();
  expect(onPlace).toHaveBeenNthCalledWith(1, 'entry_reply', 0);
  expect(document.activeElement).toBe(bodyOf('first'));
  expect(document.getSelection()?.toString()).toBe('quick brown');
});

it('gone looking in a reply out of the window and found nothing: back where the chip was', async () => {
  const { Later, onPlace } = later('Nothing like the quote is left here.');
  await mount(timeline(<Later />, sentIn(sent())), { onPlace });
  await goBack();
  expect(onPlace.mock.calls).toEqual([
    ['entry_reply', 0],
    ['entry_sent', 0],
  ]);
  expect(description()).toBe(messages.Composer.quoteNotFound);
  expect(detail()?.querySelector('blockquote')?.textContent).toBe('quick brown');
});

it('a chip whose row is drawn again still says its passage was not found', async () => {
  const item = sent();
  function Toggle() {
    const [drawn, setDrawn] = useState(true);
    toggle.set = setDrawn;
    return drawn ? sentIn(item, 'entry_kept') : null;
  }
  const toggle = { set: (_drawn: boolean) => {} };
  await mount(
    <>
      {replies('Nothing like the quote is left here.')}
      <Toggle />
    </>,
  );
  await goBack();
  await act(async () => toggle.set(false));
  expect(chip()).toBeUndefined();
  await act(async () => toggle.set(true));
  expect(description()).toBe(messages.Composer.quoteNotFound);
  expect(detail()?.textContent).toContain(messages.Composer.quoteNotFound);
});

it('looks for the passage at its offsets first, then between its words', () => {
  const source = sent().provenance;
  if (source?.kind !== 'reply') throw new Error('reply source');
  expect(findPassage(REPLY, source, 'quick brown')).toEqual({ start: 4, end: 15 });
  // Two places with the same words around them: the one nearer its offsets.
  const twice = `${REPLY} ${REPLY}`;
  expect(findPassage(`xx${twice}`, source, 'quick brown')).toEqual({ start: 6, end: 17 });
  // The later place, when it is the nearer one.
  expect(findPassage(`xx${twice}`, { ...source, start: 49, end: 60 }, 'quick brown')).toEqual({
    start: 51,
    end: 62,
  });
  // The words alone, without those around them, are not the passage.
  expect(findPassage('quick brown fox', source, 'quick brown')).toBeNull();
});
