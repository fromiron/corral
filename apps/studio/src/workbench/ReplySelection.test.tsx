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

async function mount(children: ReactNode, onGoTo = vi.fn()) {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  await act(async () =>
    root.render(
      <IntlProvider locale="en" messages={messages} timeZone="UTC">
        <ReplySelection target={target} onGoTo={onGoTo} />
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
const chip = () =>
  [...document.querySelectorAll('button')].find((button) =>
    button.getAttribute('aria-label')?.startsWith('Go to the quoted passage'),
  );
async function goBack(item: TextAttachment) {
  await act(async () => chip()?.click());
  await vi.waitFor(() => {
    if (!settled(item)) throw new Error('not yet');
  });
}
const settled = (_item: TextAttachment) =>
  document.activeElement?.hasAttribute('data-reply-body') ||
  document.body.textContent?.includes(messages.Composer.quoteNotFound);
const bodyOf = (testId: string) =>
  document.querySelector(`[data-testid="${testId}"]`)?.closest('[data-reply-body]');

it('a sent quote leads to its passage at its offsets, and the passage takes focus', async () => {
  const onGoTo = vi.fn();
  const item = sent();
  await mount(
    <>
      {replies()}
      <SentQuotes attachments={[item]} />
    </>,
    onGoTo,
  );
  await goBack(item);
  expect(onGoTo).toHaveBeenCalledWith('run_a');
  expect(document.activeElement).toBe(bodyOf('first'));
  expect(document.getSelection()?.toString()).toBe('quick brown');
  // The conversation's own selection of the passage shows no toolbar.
  expect(toolbar()).toBeNull();
  expect(document.body.textContent).not.toContain(messages.Composer.quoteNotFound);
});

it('finds the passage by the words around it when its offsets moved', async () => {
  const item = sent();
  await mount(
    <>
      {replies(`Edited first. ${REPLY}`)}
      <SentQuotes attachments={[item]} />
    </>,
  );
  await goBack(item);
  expect(document.activeElement).toBe(bodyOf('first'));
  const range = document.getSelection()?.getRangeAt(0);
  expect(range?.toString()).toBe('quick brown');
  expect(range?.startOffset).toBe(18);
});

it('says the passage was not found, with its words in the chip’s detail', async () => {
  const item = sent();
  await mount(
    <>
      {replies('Nothing like the quote is left here.')}
      <SentQuotes attachments={[item]} />
    </>,
  );
  await goBack(item);
  const status = document.querySelector('[role="status"]');
  expect(status?.textContent).toBe(messages.Composer.quoteNotFound);
  expect(document.querySelector('blockquote')?.textContent).toBe('quick brown');
  expect(document.getSelection()?.toString()).toBe('');
});

it('never shows the same words in another reply in place of the passage', async () => {
  const item = sent();
  await mount(
    <>
      {replies('The first reply changed.', REPLY)}
      <SentQuotes attachments={[item]} />
    </>,
  );
  await goBack(item);
  expect(document.body.textContent).toContain(messages.Composer.quoteNotFound);
  expect(document.activeElement).not.toBe(bodyOf('second'));
  expect(document.getSelection()?.toString()).toBe('');
});

it('waits for a reply whose row was out of the window to be drawn', async () => {
  const item = sent();
  function Later() {
    const [shown, setShown] = useState(false);
    later.show = () => setShown(true);
    return shown ? replies() : null;
  }
  const later = { show: () => {} };
  const onGoTo = vi.fn(() => setTimeout(() => act(() => later.show()), 50));
  await mount(
    <>
      <Later />
      <SentQuotes attachments={[item]} />
    </>,
    onGoTo,
  );
  await goBack(item);
  expect(document.activeElement).toBe(bodyOf('first'));
  expect(document.getSelection()?.toString()).toBe('quick brown');
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
