import { createEditTool } from '@earendil-works/pi-coding-agent';
import { expect, it, vi } from 'vitest';
import { editText } from '../src/edit.ts';

type Edit = { oldText: string; newText: string };
async function reference(text: string, edits: Edit[]) {
  let written = text;
  const tool = createEditTool('/virtual', {
    operations: {
      access: async () => {},
      readFile: async () => Buffer.from(text),
      writeFile: async (_path, content) => {
        written = content;
      },
    },
  });
  const result = await tool.execute('tool_1', { path: 'a.txt', edits });
  return { text: written, result };
}

it.each([
  {
    name: 'multiple edits with BOM and CRLF',
    text: '\ufeffalpha\r\nbeta\r\ngamma\r\n',
    edits: [
      { oldText: 'alpha', newText: 'first' },
      { oldText: 'gamma', newText: 'last' },
    ],
  },
  {
    name: 'typographic quotes',
    text: 'unchanged  \n“hello”\n',
    edits: [{ oldText: '"hello"', newText: 'world' }],
  },
])('preserves official Pi semantics through an isolated worker: $name', async ({ text, edits }) => {
  expect(await editText({ path: 'a.txt', text, edits })).toEqual(await reference(text, edits));
});

it.each([
  { name: 'missing match', text: 'one two', edits: [{ oldText: 'missing', newText: 'x' }] },
  { name: 'duplicate match', text: 'one one', edits: [{ oldText: 'one', newText: 'x' }] },
  {
    name: 'overlapping edits',
    text: 'one two',
    edits: [
      { oldText: 'one', newText: 'x' },
      { oldText: 'one two', newText: 'y' },
    ],
  },
  { name: 'unchanged text', text: 'one', edits: [{ oldText: 'one', newText: 'one' }] },
])('retains the official Pi error: $name', async ({ text, edits }) => {
  const message = await reference(text, edits).then(
    () => '',
    (error) => error.message,
  );
  expect(message).not.toBe('');
  await expect(editText({ path: 'a.txt', text, edits })).rejects.toThrow(message);
});

it('cancelled or invalid edits never spawn a worker', async () => {
  const spawn = vi.fn();
  await expect(
    editText(
      { path: 'a.txt', text: 'x', edits: [{ oldText: 'x', newText: 'y' }] },
      { spawn, cancellation: { aborted: true, onCancel: () => () => {} } },
    ),
  ).rejects.toThrow(/cancelled/i);
  await expect(
    editText({ path: '../secret', text: 'x', edits: [{ oldText: 'x', newText: 'y' }] }, { spawn }),
  ).rejects.toThrow();
  expect(spawn).not.toHaveBeenCalled();
});
