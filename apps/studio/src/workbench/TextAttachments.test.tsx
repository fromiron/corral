// @vitest-environment jsdom
import { createTextAttachment } from '@corral/core';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { QuoteChip, TextAttachmentList, TextAttachmentPicker } from './TextAttachments.tsx';

vi.mock('use-intl', () => ({ useTranslations: () => (key: string) => key }));
afterEach(() => vi.unstubAllGlobals());

it('keeps the sent attachment name visible and its complete hash inside the closed details', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const attachment = createTextAttachment('review.md', 'text/markdown', 'Original review body.');
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(<TextAttachmentList attachments={[attachment]} />));
    const details = container.querySelector('details');
    const summary = details?.querySelector('summary');
    expect(summary?.textContent).toContain('review.md');
    expect(summary?.textContent).toContain(`${attachment.bytes} B`);
    expect(summary?.textContent).not.toContain(attachment.sha256.slice(0, 12));
    expect(details?.open).toBe(false);
    expect(details?.textContent).toContain(attachment.sha256);
    expect(container.querySelector('pre')?.textContent).toBe(attachment.text);
    await act(async () => summary?.click());
    expect(details?.open).toBe(true);
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

it('a file upload with identical text preserves a captured source with different provenance', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const text = 'same body';
  const captured = createTextAttachment('selection.txt', 'text/plain', text, {
    kind: 'check',
    hostId: 'host',
    projectId: 'project',
    sessionId: 'session',
    verificationId: 'check',
    commandId: 'test',
    tree: 'a'.repeat(40),
  });
  const file = new File([text], 'selection.txt', { type: 'text/plain' });
  Object.defineProperty(file, 'arrayBuffer', {
    value: async () => new TextEncoder().encode(text).buffer,
  });
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const onChange = vi.fn();
  try {
    await act(async () =>
      root.render(
        <TextAttachmentPicker
          value={[captured]}
          onChange={onChange}
          onLoading={() => {}}
          disabled={false}
          enabled
        />,
      ),
    );
    const input = container.querySelector('input');
    if (!input) throw new Error('Missing file picker');
    Object.defineProperty(input, 'files', { value: [file] });
    await act(async () => input.dispatchEvent(new Event('change', { bubbles: true })));
    expect(onChange).toHaveBeenCalledOnce();
    expect(onChange.mock.calls[0]?.[0]).toEqual([
      captured,
      createTextAttachment('selection.txt', 'text/plain', text),
    ]);
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

const quoteOf = (text: string) =>
  createTextAttachment('quote.txt', 'text/plain', text, {
    kind: 'reply',
    runId: 'run_quoted',
    modelCallId: 'call_quoted',
    start: 0,
    end: text.length,
    prefix: '',
    suffix: '',
  });

async function renderChip(item: ReturnType<typeof quoteOf>, onRemove = vi.fn(), disabled = false) {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  await act(async () =>
    root.render(
      <ul>
        <QuoteChip item={item} onRemove={onRemove} disabled={disabled} />
      </ul>,
    ),
  );
  return {
    container,
    chip: container.querySelector('li'),
    cleanup: async () => {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

it('a quote chip shows the quote mark and the first 40 characters, folding line breaks', async () => {
  const text = 'First line of the reply\nsecond line that runs well past forty characters';
  const folded = text.replace('\n', ' ');
  const { chip, cleanup } = await renderChip(quoteOf(text));
  try {
    expect(chip?.querySelector('svg')).not.toBeNull();
    expect(chip?.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
    const visible = chip?.querySelector('[aria-hidden=true][title]');
    expect(visible?.textContent).toBe(`${[...folded].slice(0, 40).join('')}…`);
    expect(visible?.getAttribute('title')).toBe(folded);
    expect(chip?.querySelector('.sr-only')?.textContent).toBe(`quote: ${folded}`);
    // The same height as a reference chip in the chip row.
    expect(chip?.className).toContain('py-0.5');
    expect(chip?.className).toContain('text-caption');
  } finally {
    await cleanup();
  }
});

it.each([
  // A family emoji joined by ZWJs, and Hangul built of conjoining jamo, each one character.
  ['an emoji sequence', '👨‍👩‍👧'],
  ['conjoining Hangul', '각'],
])('a quote chip cuts its opening between characters, never inside %s', async (_name, unit) => {
  // The 40th character is the multi-unit one, so a cut by code point would split it.
  const text = `${'a'.repeat(39)}${unit}${'b'.repeat(10)}`;
  const { chip, cleanup } = await renderChip(quoteOf(text));
  try {
    expect(chip?.querySelector('[aria-hidden=true][title]')?.textContent).toBe(
      `${'a'.repeat(39)}${unit}…`,
    );
  } finally {
    await cleanup();
  }
});

it('a short quote shows whole, with no ellipsis', async () => {
  const { chip, cleanup } = await renderChip(quoteOf('Short'));
  try {
    expect(chip?.querySelector('[aria-hidden=true][title]')?.textContent).toBe('Short');
  } finally {
    await cleanup();
  }
});

it('a quote chip is removed by its own named button, like another chip', async () => {
  const onRemove = vi.fn();
  const item = quoteOf('Removable passage');
  const { chip, cleanup } = await renderChip(item, onRemove);
  try {
    const button = chip?.querySelector('button');
    expect(button?.getAttribute('type')).toBe('button');
    expect(button?.getAttribute('aria-label')).toBe('removeQuote');
    button?.focus();
    expect(document.activeElement).toBe(button);
    await act(async () => button?.click());
    expect(onRemove).toHaveBeenCalledOnce();
  } finally {
    await cleanup();
  }
  const blocked = vi.fn();
  const disabled = await renderChip(item, blocked, true);
  try {
    const button = disabled.chip?.querySelector('button');
    expect(button?.disabled).toBe(true);
    await act(async () => button?.click());
    expect(blocked).not.toHaveBeenCalled();
  } finally {
    await disabled.cleanup();
  }
});
