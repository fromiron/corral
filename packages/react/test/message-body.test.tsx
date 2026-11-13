import { fireEvent, render, waitFor } from '@testing-library/react';
import { IntlProvider } from 'use-intl';
import { afterEach, expect, it, vi } from 'vitest';
import { MessageBody } from '../src/components/MessageBody.tsx';
import { SafeMarkdown } from '../src/components/SafeMarkdown.tsx';
import messages from '../src/messages/en.json' with { type: 'json' };

afterEach(() => vi.unstubAllGlobals());
const show = (children: React.ReactNode) =>
  render(
    <IntlProvider locale="en" messages={messages} timeZone="UTC">
      {children}
    </IntlProvider>,
  );
it('collapses a long message, expands accessibly, and copies the complete unchanged text', async () => {
  const writeText = vi.fn(async () => {});
  vi.stubGlobal('navigator', { clipboard: { writeText } });
  const text = `${'long request '.repeat(1000)}END`;
  const view = show(<MessageBody text={text} />);
  expect(view.container.textContent).not.toContain('END');
  const expand = view.getByRole('button', { name: 'Show full message' });
  expect(expand.getAttribute('aria-expanded')).toBe('false');
  fireEvent.click(expand);
  expect(view.container.textContent).toContain('END');
  expect(view.getByRole('button', { name: 'Collapse message' }).getAttribute('aria-expanded')).toBe(
    'true',
  );
  fireEvent.click(view.getByRole('button', { name: 'Copy message' }));
  await waitFor(() => expect(writeText).toHaveBeenCalledWith(text));
  expect(view.container.querySelector('[role="status"]')?.textContent).toBe('Copied');
});
it('copies exactly fenced code and reports clipboard denial without losing the source', async () => {
  const writeText = vi.fn(async () => {
    throw new Error('denied');
  });
  vi.stubGlobal('navigator', { clipboard: { writeText } });
  const source = 'const value = "<img onerror=alert(1)>";\n';
  const view = show(<SafeMarkdown text={`\`\`\`ts\n${source}\`\`\``} />);
  fireEvent.click(view.getByRole('button', { name: 'Copy code' }));
  await waitFor(() => expect(view.getByRole('status').textContent).toContain('Could not copy'));
  expect(writeText).toHaveBeenCalledWith(source);
  expect(view.container.querySelector('pre code')?.textContent).toBe(source);
});

it('keeps a long assistant code block complete for code copy', async () => {
  const writeText = vi.fn(async () => {});
  vi.stubGlobal('navigator', { clipboard: { writeText } });
  const source = `${'const value = 1;\n'.repeat(400)}// END\n`;
  const view = show(<MessageBody markdown text={`\`\`\`ts\n${source}\`\`\``} />);
  fireEvent.click(view.getByRole('button', { name: 'Copy code' }));
  await waitFor(() => expect(writeText).toHaveBeenCalledWith(source));
  expect(view.container.querySelector('pre code')?.textContent).toBe(source);
});

it('draws a reply again in the same code block, table and link, so a passage chosen in them stays', () => {
  const text = [
    '```ts',
    'const answer = 42;',
    '```',
    '',
    '| Name | Value |',
    '| --- | --- |',
    '| alpha | one |',
    '',
    'A [link](https://example.com) here.',
  ].join('\n');
  const view = show(<SafeMarkdown text={text} size="chat" />);
  const drawn = ['pre', 'table', 'a'].map((tag) => view.container.querySelector(tag));
  expect(drawn.every(Boolean)).toBe(true);
  view.rerender(
    <IntlProvider locale="en" messages={messages} timeZone="UTC">
      <SafeMarkdown text={text} size="chat" />
    </IntlProvider>,
  );
  expect(['pre', 'table', 'a'].map((tag) => view.container.querySelector(tag))).toEqual(drawn);
  expect(drawn.every((node) => node?.isConnected)).toBe(true);
});

it('leaves a code block’s language and copy button out of what a copy over it takes', () => {
  const view = show(<SafeMarkdown text={'```ts\nconst answer = 42;\n```'} />);
  const header = view.getByRole('button', { name: 'Copy code' }).closest('[data-copy-skip]');
  expect(header?.className).toContain('select-none');
  expect(header?.contains(view.container.querySelector('pre'))).toBe(false);
});
