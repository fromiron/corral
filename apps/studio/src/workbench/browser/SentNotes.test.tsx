// @vitest-environment jsdom
import { PAGE_ANNOTATION_WARNING } from '@corral/contracts';
import { createTextAttachment } from '@corral/core';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { IntlProvider } from 'use-intl';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import messages from '../../../../../packages/react/src/messages/en.json' with { type: 'json' };
import { SentNotes } from './SentNotes.tsx';

// A page note in a sent request shows what it carried (features/browser-annotate.md 보내는 것:
// 보이는 것): the same contents as its chip and the overlay, from the note's body, its screenshot
// from the request's image, all as plain text.

const cleanup: (() => void)[] = [];
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
});
afterEach(() => {
  for (const dispose of cleanup.splice(0)) act(dispose);
  vi.unstubAllGlobals();
});

const body = (text = 'Pay now', written = 'Make the button larger') =>
  JSON.stringify({
    warning: PAGE_ANNOTATION_WARNING,
    page: { kind: 'page', origin: 'https://shop.example', path: '/cart' },
    pickedAt: '2026-11-18T12:00:00.000Z',
    generation: 2,
    note: written,
    element: {
      tag: 'button',
      label: 'button.pay 120×32',
      role: null,
      selector: 'body > button:nth-of-type(1)',
      text,
      bounds: { x: 0, y: 0, width: 120, height: 32 },
      styles: {},
    },
    styles: [{ property: 'font-size', before: '16px', after: '20px' }],
  });
const SHOT = 'e'.repeat(64);
const note = (name: string, text?: string, written?: string) =>
  createTextAttachment(name, 'application/json', body(text, written), {
    kind: 'page',
    origin: 'https://shop.example',
    path: '/cart',
    pickedAt: '2026-11-18T12:00:00.000Z',
    generation: 2,
    screenshotHash: SHOT,
  });
const image = {
  kind: 'image_attachment' as const,
  imageId: 'image_shot',
  name: 'annotation.png',
  mime: 'image/png' as const,
  bytes: 68,
  sha256: SHOT,
  width: 120,
  height: 32,
};

async function show(props: Parameters<typeof SentNotes>[0]) {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  cleanup.push(() => {
    root.unmount();
    container.remove();
  });
  await act(async () =>
    root.render(
      <IntlProvider locale="en" messages={messages} timeZone="UTC">
        <SentNotes {...props} />
      </IntlProvider>,
    ),
  );
  return container;
}

it('a note sent at once shows its page, name tag, selector, style changes and its screenshot from the request', async () => {
  const container = await show({
    attachments: [note('annotation.json')],
    images: [image],
    imageUrl: (imageId) => `/images/${imageId}`,
  });
  const text = container.textContent ?? '';
  expect(text).toContain('button.pay 120×32');
  expect(text).toContain('https://shop.example/cart');
  expect(text).toContain('body > button:nth-of-type(1)');
  expect(text).toContain('font-size');
  const shot = container.querySelector('img');
  expect(shot?.getAttribute('src')).toBe('/images/image_shot');
  expect(shot?.getAttribute('alt')).toBe(
    messages.Browser.noteShotOf.replace('{label}', 'button.pay 120×32'),
  );
});

it('collected notes keep their numbers, and a page’s text stays text (반례: no markup from the page)', async () => {
  const container = await show({
    attachments: [note('annotation-2.json', '<b>bold</b><img src=x onerror=alert(1)>')],
    images: [],
    imageUrl: () => null,
  });
  expect(container.textContent).toContain(
    messages.Browser.noteChip.replace('{n}', '2').replace('{label}', 'button.pay 120×32'),
  );
  expect(container.textContent).toContain('<b>bold</b>');
  expect(container.querySelector('b')).toBeNull();
  expect(container.querySelector('img')).toBeNull();
});

it('a sent note shows its written note first, as text (반례: markup in the note makes no element)', async () => {
  const container = await show({
    attachments: [
      note('annotation-1.json', 'Pay now', 'Make the button larger'),
      note('annotation-2.json', 'Pay now', '<i>tilt</i><img src=x onerror=alert(1)>'),
    ],
    images: [],
    imageUrl: () => null,
  });
  const contents = [...container.querySelectorAll('details > div')].map(
    (each) => each.textContent ?? '',
  );
  expect(contents[0]?.startsWith('Make the button larger')).toBe(true);
  expect(contents[1]?.startsWith('<i>tilt</i><img src=x onerror=alert(1)>')).toBe(true);
  expect(container.querySelector('i')).toBeNull();
  expect(container.querySelector('img')).toBeNull();
});

it('a note sent at once does not repeat its note, which is the request’s own text: the entry shows it once', async () => {
  const container = await show({
    attachments: [note('annotation.json', 'Pay now', 'Make the button larger')],
    images: [],
    imageUrl: () => null,
  });
  expect(container.textContent).toContain('button.pay 120×32');
  expect(container.textContent).not.toContain('Make the button larger');
});

it('attachments that are not page notes show nothing here', async () => {
  const container = await show({
    attachments: [createTextAttachment('notes.md', 'text/markdown', 'plain notes')],
    images: [],
    imageUrl: () => null,
  });
  expect(container.textContent).toBe('');
});
