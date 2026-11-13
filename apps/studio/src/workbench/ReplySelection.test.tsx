// @vitest-environment jsdom
import type { TextAttachment } from '@corral/contracts';
import { createTextAttachment } from '@corral/core';
import { act, type ReactNode, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { IntlProvider } from 'use-intl';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import messages from '../../../../packages/react/src/messages/en.json' with { type: 'json' };
import { runShortcut } from '../commandRegistry.ts';
import type { PlacedRow } from './ChatView.tsx';
import { type AttachmentRequest, COMPOSER_ATTACH } from './context/bridge.ts';
import { findPassage, ReplyBody, ReplySelection, runRow, SentQuotes } from './ReplySelection.tsx';

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

const placed = (following = false, held = () => true) => ({ following, held });

async function mount(
  children: ReactNode,
  {
    onPlace = vi.fn(() => placed()),
    onFollow = vi.fn(),
    rowOf = (runId: string) => (runId === 'run_a' ? 'entry_reply' : undefined),
  }: {
    onPlace?: (id: string, offset: number) => PlacedRow | null;
    onFollow?: () => void;
    rowOf?: (runId: string) => string | undefined;
  } = {},
) {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const render = (on = target) =>
    act(async () =>
      root.render(
        <IntlProvider locale="en" messages={messages} timeZone="UTC">
          <ReplySelection target={on} rowOf={rowOf} onPlace={onPlace} onFollow={onFollow} />
          {children}
        </IntlProvider>,
      ),
    );
  await render();
  cleanup.push(async () => {
    await act(async () => root.unmount());
    container.remove();
  });
  return Object.assign(container, { render });
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
async function select(from: Node, start: number, to: Node, end: number) {
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
    return placed();
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

// Choices a browser makes by hand: an end just past the body, a press elsewhere, the pointer held.

/** A reply with a line read aloud after it, as a run row has, then a reply after that. */
const edged = () => (
  <>
    <span data-testid="before">Asked</span>
    <ReplyBody runId="run_a" modelCallId="call_a">
      <p data-testid="first">{REPLY}</p>
    </ReplyBody>
    <span data-testid="after" className="sr-only">
      Reply ended
    </span>
    <ReplyBody runId="run_b" modelCallId="call_b">
      <p data-testid="second">Another reply entirely.</p>
    </ReplyBody>
  </>
);
const element = (testId: string) =>
  document.querySelector(`[data-testid="${testId}"]`) as HTMLElement;

it('a choice that ends or starts just past a reply’s body, with no other words in it, is that reply’s', async () => {
  await mount(edged());
  // Three clicks on the last paragraph: the browser ends the choice at the start of what follows.
  await select(text('first'), 4, element('after'), 0);
  expect(toolbar()).not.toBeNull();
  await act(async () => quoteButton()?.click());
  expect(attached[0]?.attachment.text).toBe(REPLY.slice(4));
  expect(attached[0]?.attachment.provenance).toMatchObject({ start: 4, end: REPLY.length });
  // A drag begun just before the reply.
  await select(element('before'), 1, text('first'), 9);
  expect(toolbar()).not.toBeNull();
  await act(async () => quoteButton()?.click());
  expect(attached[1]?.attachment.provenance).toMatchObject({ start: 0, end: 9 });
  // Past the body into words that are not the reply's: no toolbar.
  await select(text('first'), 4, element('after').firstChild as Text, 5);
  expect(toolbar()).toBeNull();
  await select(element('before').firstChild as Text, 2, text('first'), 9);
  expect(toolbar()).toBeNull();
});

it('a reply body without its call shows no toolbar', async () => {
  await mount(
    <div data-reply-body="" data-run-id="run_a">
      <p data-testid="first">{REPLY}</p>
    </div>,
  );
  await select(text('first'), 4, text('first'), 15);
  expect(toolbar()).toBeNull();
});

const press = (node: Element, type: string) =>
  node.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, button: 0 }));

it('the toolbar follows the selection: a press elsewhere leaves it, and the words chosen again bring it back', async () => {
  await mount(replies());
  await select(text('first'), 4, text('first'), 15);
  expect(toolbar()).not.toBeNull();
  // A press on something that keeps the selection where it is.
  await act(async () => {
    for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'])
      press(element('outside'), type);
  });
  await act(async () => {});
  expect(toolbar()).not.toBeNull();
  // Put away; the browser saying the same selection again keeps it away.
  await act(async () =>
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })),
  );
  expect(toolbar()).toBeNull();
  await act(async () => document.dispatchEvent(new Event('selectionchange')));
  expect(toolbar()).toBeNull();
  // The same words chosen again by the pointer: a new choice.
  await act(async () => press(text('first').parentElement as Element, 'pointerdown'));
  await select(text('first'), 4, text('first'), 15);
  expect(toolbar()).toBeNull();
  await act(async () => press(text('first').parentElement as Element, 'pointerup'));
  expect(toolbar()).not.toBeNull();
});

it('a drag shows the toolbar where it ends, not on the way', async () => {
  await mount(replies());
  await act(async () => press(text('first').parentElement as Element, 'pointerdown'));
  await select(text('first'), 4, text('first'), 9);
  await select(text('first'), 4, text('first'), 15);
  expect(toolbar()).toBeNull();
  await act(async () => press(text('first').parentElement as Element, 'pointerup'));
  expect(toolbar()).not.toBeNull();
  await act(async () => quoteButton()?.click());
  expect(attached[0]?.attachment.text).toBe('quick brown');
});

it('names the toolbar for what it acts on', async () => {
  await mount(replies());
  await select(text('first'), 4, text('first'), 15);
  expect(toolbar()?.getAttribute('role')).toBe('toolbar');
  expect(toolbar()?.getAttribute('aria-label')).toBe(messages.Composer.selectedPassage);
});

it('takes the context around a passage without cutting a character in two', async () => {
  // A character of two units sits where each side's 32 units would end.
  const reply = `x\u{1F600}${'y'.repeat(31)}Q${'z'.repeat(31)}\u{1F600}w`;
  await mount(replies(reply));
  await select(text('first'), 34, text('first'), 35);
  await act(async () => quoteButton()?.click());
  expect(attached[0]?.attachment.provenance).toMatchObject({
    start: 34,
    end: 35,
    prefix: 'y'.repeat(31),
    suffix: 'z'.repeat(31),
  });
});

it('counts a code block’s language and copy button out of the reply’s text', async () => {
  await mount(
    <ReplyBody runId="run_a" modelCallId="call_a">
      <p data-testid="first">Before.</p>
      <div data-copy-skip="">
        <span>ts</span>
        <button type="button">Copy</button>
      </div>
      <pre>
        <code data-testid="code">const answer = 42;</code>
      </pre>
    </ReplyBody>,
  );
  await select(text('code'), 0, text('code'), 5);
  await act(async () => quoteButton()?.click());
  expect(attached[0]?.attachment.provenance).toMatchObject({
    start: 7,
    end: 12,
    prefix: 'Before.',
    suffix: ' answer = 42;',
  });
});

// The way back, with what each step decides.

/** The CSS highlight registry, as a browser that has one keeps it. */
function highlights() {
  const registry = new Map<string, unknown>();
  vi.stubGlobal('CSS', { highlights: registry });
  vi.stubGlobal(
    'Highlight',
    class {
      range: Range;
      constructor(range: Range) {
        this.range = range;
      }
    },
  );
  return registry;
}

it('marks the passage found for two seconds, then lets the mark go', async () => {
  const registry = highlights();
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  try {
    await mount(
      <>
        {replies()}
        {sentIn(sent())}
      </>,
    );
    await act(async () => chip()?.click());
    expect((registry.get('corral-quote') as { range: Range } | undefined)?.range.toString()).toBe(
      'quick brown',
    );
    await act(async () => vi.advanceTimersByTime(1_999));
    expect(registry.has('corral-quote')).toBe(true);
    await act(async () => vi.advanceTimersByTime(1));
    expect(registry.has('corral-quote')).toBe(false);
  } finally {
    vi.useRealTimers();
  }
});

it('never takes another call’s body of the same run, nor the same call’s body of another run', async () => {
  await mount(
    <>
      <ReplyBody runId="run_a" modelCallId="call_other">
        <p>{REPLY}</p>
      </ReplyBody>
      <ReplyBody runId="run_other" modelCallId="call_a">
        <p>{REPLY}</p>
      </ReplyBody>
      {sentIn(sent())}
    </>,
    { rowOf: () => undefined },
  );
  await goBack();
  expect(description()).toBe(messages.Composer.quoteNotFound);
  expect(document.getSelection()?.toString()).toBe('');
});

it('a quote of a run the conversation does not show is not found at once, and nothing moves', async () => {
  const onPlace = vi.fn(() => placed());
  await mount(sentIn(sent()), { rowOf: () => undefined, onPlace });
  await goBack();
  expect(description()).toBe(messages.Composer.quoteNotFound);
  expect(onPlace).not.toHaveBeenCalled();
});

it('a chip that finds its passage again no longer says it was not found', async () => {
  function Reply() {
    const [first, setFirst] = useState('Nothing like the quote is left here.');
    restore.set = () => setFirst(REPLY);
    return replies(first);
  }
  const restore = { set: () => {} };
  await mount(
    <>
      <Reply />
      {sentIn(sent())}
    </>,
  );
  await goBack();
  expect(description()).toBe(messages.Composer.quoteNotFound);
  await act(async () => restore.set());
  await act(async () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })));
  await goBack();
  expect(document.getSelection()?.toString()).toBe('quick brown');
  expect(description()).toBe('');
  expect(chip()?.getAttribute('aria-expanded')).toBe('false');
});

it('says “not found” again on each press, as a change of the live region', async () => {
  await mount(
    <>
      {replies('Nothing like the quote is left here.')}
      {sentIn(sent())}
    </>,
  );
  const region = document.querySelector('[role="status"]') as HTMLElement;
  const heard: string[] = [];
  const listen = new MutationObserver(() => heard.push(region.textContent ?? ''));
  listen.observe(region, { childList: true, characterData: true, subtree: true });
  await goBack();
  await act(async () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })));
  await goBack();
  listen.disconnect();
  expect(heard.filter((words) => words === messages.Composer.quoteNotFound)).toHaveLength(2);
  expect(heard.at(-2)).toBe('');
});

it('a sent chip names its detail, says whether it is open, keeps focus, and closes it as focus leaves', async () => {
  await mount(
    <>
      {replies('Nothing like the quote is left here.')}
      {sentIn(sent())}
      <button type="button" data-testid="next">
        Next
      </button>
    </>,
  );
  expect(chip()?.getAttribute('aria-expanded')).toBe('false');
  chip()?.focus();
  await goBack();
  await vi.waitFor(() => expect(detail()).not.toBeNull());
  expect(chip()?.getAttribute('aria-expanded')).toBe('true');
  expect(chip()?.getAttribute('aria-haspopup')).toBe('dialog');
  const name = detail()?.getAttribute('aria-labelledby') ?? '';
  expect(document.getElementById(name)?.textContent).toBe(messages.Composer.quoteNotFound);
  // The detail opens without taking focus from the chip.
  await act(async () => new Promise((resolve) => setTimeout(resolve, 50)));
  expect(document.activeElement).toBe(chip());
  // Focus moves on: the detail goes.
  await act(async () => element('next').focus());
  await vi.waitFor(() => expect(detail()).toBeNull());
  expect(chip()?.getAttribute('aria-expanded')).toBe('false');
  // Focus stays where it went.
  await act(async () => new Promise((resolve) => setTimeout(resolve, 50)));
  expect(document.activeElement).toBe(element('next'));
});

it('a sent message’s chips are its reply quotes alone', async () => {
  const file = createTextAttachment('notes.txt', 'text/plain', 'Some notes');
  await mount(<SentQuotes attachments={[file, sent()]} owner="entry_mixed" />);
  expect(chips()).toHaveLength(1);
  expect(chip()?.getAttribute('aria-label')).toBe('Go to the quoted passage: quick brown');
});

it('leads a quote back to the row of the entry that ran it, or to the run’s own row', () => {
  const entries = [
    { entryId: 'entry_1', runId: 'run_1' },
    { entryId: 'entry_2', runId: null },
  ];
  expect(runRow(entries, [{ runId: 'run_loose' }], 'run_1')).toBe('entry_1');
  expect(runRow(entries, [{ runId: 'run_loose' }], 'run_loose')).toBe('run_loose');
  expect(runRow(entries, [{ runId: 'run_loose' }], 'run_gone')).toBeUndefined();
});

/**
 * A timeline drawn with sizes: its top at 0, the composer from 600, and the reply's row at
 * `rowTop` with the passage's first line at `lineTop`.
 */
function laidOut(rowTop: number, lineTop: number) {
  const rect = (top: number, height = 20) =>
    ({
      top,
      bottom: top + height,
      left: 0,
      right: 480,
      width: 480,
      height,
      x: 0,
      y: top,
    }) as DOMRect;
  const own = Element.prototype.getBoundingClientRect;
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    if (this.matches('[data-testid="chat-timeline"]')) return rect(0, 800);
    if (this.matches('[data-testid="chat-composer"]')) return rect(600, 200);
    if (this.matches('[data-chat-window]')) return rect(0, 800);
    if (this.matches('[data-chat-item="entry_reply"]')) return rect(rowTop, 2000);
    return own.call(this);
  });
  Object.defineProperty(Range.prototype, 'getClientRects', {
    configurable: true,
    value: () => [rect(lineTop)],
  });
  return () => {
    vi.restoreAllMocks();
    delete (Range.prototype as { getClientRects?: unknown }).getClientRects;
  };
}
const withComposer = (children: ReactNode) => (
  <>
    {children}
    <div data-testid="chat-composer" />
  </>
);

it('a passage in view is led back to where it is, the view left alone', async () => {
  const restore = laidOut(100, 300);
  try {
    const onPlace = vi.fn(() => placed());
    await mount(withComposer(timeline(replies(), sentIn(sent()))), { onPlace });
    await goBack();
    expect(document.getSelection()?.toString()).toBe('quick brown');
    expect(onPlace).not.toHaveBeenCalled();
  } finally {
    restore();
  }
});

it('a passage out of view is put a third of the way down the view', async () => {
  const restore = laidOut(100, 900);
  try {
    const onPlace = vi.fn(() => placed());
    await mount(withComposer(timeline(replies(), sentIn(sent()))), { onPlace });
    await goBack();
    // 600 of the view above the composer: the line 200 down, 800 below its row's top.
    expect(onPlace).toHaveBeenCalledWith('entry_reply', 600 / 3 - 800);
  } finally {
    restore();
  }
});

// Gone looking far away, and found nothing in the wait.

/** A reply that is never drawn: its row is in the conversation, its words never come. */
const never = () => vi.fn((_id: string, _offset: number) => placed());

it('waits four seconds for the reply to be drawn, then comes back to the chip', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  try {
    const onPlace = never();
    await mount(timeline(null, sentIn(sent())), { onPlace });
    await act(async () => chip()?.click());
    expect(onPlace.mock.calls).toEqual([['entry_reply', 0]]);
    await act(async () => vi.advanceTimersByTime(3_999));
    expect(description()).toBe('');
    await act(async () => vi.advanceTimersByTime(1));
    expect(description()).toBe(messages.Composer.quoteNotFound);
    expect(onPlace.mock.calls).toEqual([
      ['entry_reply', 0],
      ['entry_sent', 0],
    ]);
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    vi.useRealTimers();
  }
});

it('a conversation that followed its end before the press follows it again after the wait', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  try {
    const onPlace = vi.fn((_id: string, _offset: number) => placed(true));
    const onFollow = vi.fn();
    await mount(timeline(null, sentIn(sent())), { onPlace, onFollow });
    await act(async () => chip()?.click());
    await act(async () => vi.advanceTimersByTime(4_000));
    expect(description()).toBe(messages.Composer.quoteNotFound);
    expect(onFollow).toHaveBeenCalledOnce();
    expect(onPlace).toHaveBeenCalledOnce();
  } finally {
    vi.useRealTimers();
  }
});

it('a person who moved the conversation during the wait stays where they went', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  try {
    let held = true;
    const onPlace = vi.fn((_id: string, _offset: number) => placed(true, () => held));
    const onFollow = vi.fn();
    await mount(timeline(null, sentIn(sent())), { onPlace, onFollow });
    await act(async () => chip()?.click());
    held = false;
    await act(async () => vi.advanceTimersByTime(4_000));
    expect(description()).toBe(messages.Composer.quoteNotFound);
    expect(onFollow).not.toHaveBeenCalled();
    expect(onPlace).toHaveBeenCalledOnce();
  } finally {
    vi.useRealTimers();
  }
});

it('leaving the conversation during the wait ends it: no word, no move, nothing left running', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const disconnect = vi.spyOn(MutationObserver.prototype, 'disconnect');
  try {
    const onPlace = never();
    const view = await mount(timeline(null, sentIn(sent())), { onPlace });
    await act(async () => chip()?.click());
    await act(
      async () => new Promise((resolve) => requestAnimationFrame(() => resolve(undefined))),
    );
    const calls = disconnect.mock.calls.length;
    await view.render({ ...target, sessionId: 'another' });
    expect(disconnect.mock.calls.length).toBeGreaterThan(calls);
    expect(vi.getTimerCount()).toBe(0);
    await act(async () => vi.advanceTimersByTime(4_000));
    expect(description()).toBe('');
    expect(onPlace).toHaveBeenCalledOnce();
  } finally {
    disconnect.mockRestore();
    vi.useRealTimers();
  }
});

it('a reply drawn after its wait ended is not looked in again', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  try {
    const show = { now: () => {} };
    function Shown() {
      const [drawn, setDrawn] = useState(false);
      show.now = () => setDrawn(true);
      return drawn ? (
        <ReplyBody runId="run_a" modelCallId="call_a">
          <p data-testid="first">{REPLY}</p>
        </ReplyBody>
      ) : null;
    }
    const onPlace = never();
    await mount(timeline(<Shown />, sentIn(sent())), { onPlace });
    await act(async () => chip()?.click());
    await act(async () => vi.advanceTimersByTime(4_000));
    expect(description()).toBe(messages.Composer.quoteNotFound);
    const before = onPlace.mock.calls.length;
    await act(async () => show.now());
    await act(
      async () => new Promise((resolve) => requestAnimationFrame(() => resolve(undefined))),
    );
    expect(onPlace.mock.calls.length).toBe(before);
    expect(document.getSelection()?.toString()).toBe('');
  } finally {
    vi.useRealTimers();
  }
});

it('looks at its offsets first, whatever the words around them became', () => {
  const source = sent().provenance;
  if (source?.kind !== 'reply') throw new Error('reply source');
  expect(findPassage('The quick brown cat sat down.', source, 'quick brown')).toEqual({
    start: 4,
    end: 15,
  });
});

it('compares words without what separates them, as a copy and the body’s text differ', () => {
  const drawn = 'NameValuealphaonebetatwo\n\nAfter.';
  const source = {
    kind: 'reply' as const,
    runId: 'run_a',
    modelCallId: 'call_a',
    start: 9,
    end: 24,
    prefix: 'NameValue',
    suffix: '\n\nAfter.',
  };
  expect(findPassage(drawn, source, 'alpha\tone\nbeta\ttwo')).toEqual({ start: 9, end: 24 });
  // Moved: found between the same words around it, again without the separators.
  expect(findPassage(`Moved. ${drawn}`, source, 'alpha\tone\nbeta\ttwo')).toEqual({
    start: 16,
    end: 31,
  });
});

it('leads back to a passage from its first character, not from the end of the words before it', async () => {
  const item = createTextAttachment('quote.txt', 'text/plain', 'alpha\tone', {
    kind: 'reply',
    runId: 'run_a',
    modelCallId: 'call_a',
    start: 9,
    end: 17,
    prefix: 'NameValue',
    suffix: '',
  });
  await mount(
    <>
      <ReplyBody runId="run_a" modelCallId="call_a">
        <p>Name</p>
        <p>Value</p>
        <p data-testid="cell">alpha</p>
        <p>one</p>
      </ReplyBody>
      {sentIn(item)}
    </>,
  );
  await goBack();
  const range = document.getSelection()?.getRangeAt(0);
  expect(range?.startContainer).toBe(text('cell'));
  expect(range?.startOffset).toBe(0);
});

it('a passage found after the person moved during the wait is shown where they are, not placed', async () => {
  const restore = laidOut(100, 900);
  try {
    let held = true;
    const shown = { show: () => {} };
    function Later() {
      const [drawn, setDrawn] = useState(false);
      shown.show = () => setDrawn(true);
      return drawn ? replies() : null;
    }
    const onPlace = vi.fn((id: string, _offset: number) => {
      if (id === 'entry_reply') setTimeout(() => act(() => shown.show()), 50);
      return placed(false, () => held);
    });
    await mount(withComposer(timeline(<Later />, sentIn(sent()))), { onPlace });
    await act(async () => chip()?.click());
    held = false;
    await vi.waitFor(() => expect(document.getSelection()?.toString()).toBe('quick brown'));
    expect(onPlace.mock.calls).toEqual([['entry_reply', 0]]);
  } finally {
    restore();
  }
});

it('a chip pressed again and left in the wait still says its passage was not found', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  try {
    const view = await mount(timeline(null, sentIn(sent())), { onPlace: never() });
    await act(async () => chip()?.click());
    await act(async () => vi.advanceTimersByTime(4_000));
    expect(description()).toBe(messages.Composer.quoteNotFound);
    await act(async () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })));
    await act(async () => chip()?.click());
    await view.render({ ...target, sessionId: 'another' });
    expect(description()).toBe(messages.Composer.quoteNotFound);
  } finally {
    vi.useRealTimers();
  }
});
