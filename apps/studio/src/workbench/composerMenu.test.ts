import { describe, expect, it } from 'vitest';
import {
  type MentionItem,
  mentionToken,
  menuPlacement,
  pickedReferences,
  removeMention,
  replaceTrigger,
  selectMention,
  triggerAt,
} from './composerMenu.ts';

// the composer's `/` commands and `@` references.

describe('composer triggers', () => {
  it('binds same-name results to distinct tokens and reuses their identity without colliding with a file token', () => {
    const file: MentionItem = {
      id: 'file:result:1',
      kind: 'file',
      label: 'result:1',
      reference: { kind: 'file', path: 'result:1' },
    };
    const result: MentionItem = {
      id: 'result:a',
      kind: 'result',
      label: 'image v1',
      reference: { kind: 'result', runId: 'run', artifactVersionId: 'a' },
    };
    const first = selectMention(result, [file]);
    const second = selectMention(
      {
        ...result,
        id: 'result:b',
        reference: { ...result.reference, artifactVersionId: 'b' } as typeof result.reference,
      },
      [file, first],
    );
    expect(mentionToken(first)).toBe('@result:2');
    expect(mentionToken(second)).toBe('@result:3');
    expect(selectMention(result, [file, first, second])).toBe(first);
    const fileAfterResult = selectMention(
      {
        ...file,
        label: 'result:2',
        id: 'file:result:2',
        reference: { kind: 'file', path: 'result:2' },
      },
      [first, second],
    );
    expect(mentionToken(fileAfterResult)).not.toBe(mentionToken(first));
  });
  it('keeps a shared legacy result token until its last selected reference is removed', () => {
    const first: MentionItem = {
      id: 'result:a',
      kind: 'result',
      label: 'notes v1',
      detail: 'Run #1 · Writer',
      reference: { kind: 'result', runId: 'one', artifactVersionId: 'a' },
    };
    const second: MentionItem = {
      ...first,
      id: 'result:b',
      detail: 'Run #2 · Writer',
      reference: { kind: 'result', runId: 'two', artifactVersionId: 'b' },
    };
    const picked = [first, second];
    const single = '@"notes v1"';
    expect(removeMention(single, first, picked)).toBe(single);
    const remaining = removeMention(`${single} ${single}`, first, picked);
    expect(remaining.trim()).toBe(single);
    expect(pickedReferences(remaining, [second])).toEqual([second.reference]);
    expect(removeMention(single, second, [second])).toBe('');
  });
  it('preserves prose spacing, fenced-code indentation and another reference containing double spaces', () => {
    const file: MentionItem = {
      id: 'file:a',
      kind: 'file',
      label: 'a.ts',
      reference: { kind: 'file', path: 'a.ts' },
    };
    const kept: MentionItem = {
      id: 'file:notes',
      kind: 'file',
      label: 'my  notes.md',
      reference: { kind: 'file', path: 'my  notes.md' },
    };
    const text = 'a  b\n```ts\n    indented();\n```\nRead @a.ts @"my  notes.md"';
    const remaining = removeMention(text, file);
    expect(remaining).toBe('a  b\n```ts\n    indented();\n```\nRead @"my  notes.md"');
    expect(pickedReferences(remaining, [file, kept])).toEqual([kept.reference]);
  });
  it('removes only whole reference tokens in either order, including quoted paths and duplicates', () => {
    const file: MentionItem = {
      id: 'file:a',
      kind: 'file',
      label: 'my notes.md',
      reference: { kind: 'file', path: 'my notes.md' },
    };
    const range: MentionItem = {
      ...file,
      id: 'file:a:range',
      lines: { start: 1, end: 3 },
      reference: { kind: 'file', path: 'my notes.md', lines: { start: 1, end: 3 } },
    };
    const text = 'Read @"my notes.md" @"my notes.md":L1-L3 @"my notes.md":L1-L30 @"my notes.md"';
    const wholeFirst = removeMention(text, file);
    expect(wholeFirst).toBe('Read @"my notes.md":L1-L3 @"my notes.md":L1-L30 ');
    expect(pickedReferences(wholeFirst, [file, range])).toEqual([range.reference]);
    const rangeFirst = removeMention(text, range);
    expect(rangeFirst).toBe('Read @"my notes.md" @"my notes.md":L1-L30 @"my notes.md"');
    expect(pickedReferences(rangeFirst, [file, range])).toEqual([file.reference]);
    expect(removeMention('@"my notes.md":L1-L3', range)).toBe('');
  });
  it('opens commands only for `/` at the very start', () => {
    expect(triggerAt('/pa', 3)).toEqual({ kind: 'slash', query: 'pa', start: 0, end: 3 });
    expect(triggerAt('/', 1)).toEqual({ kind: 'slash', query: '', start: 0, end: 1 });
    expect(triggerAt('see a/b', 7)).toBeNull();
    expect(triggerAt('text /pa', 8)).toBeNull();
    expect(triggerAt('/pause now', 10)).toBeNull();
  });

  it('opens references for `@` after a space or at the start', () => {
    expect(triggerAt('look at @src/ap', 15)).toEqual({
      kind: 'mention',
      query: 'src/ap',
      start: 8,
      end: 15,
    });
    expect(triggerAt('@', 1)).toEqual({ kind: 'mention', query: '', start: 0, end: 1 });
    expect(triggerAt('mail a@b.c', 10)).toBeNull();
    expect(triggerAt('@a done', 7)).toBeNull();
  });

  it('replaces the trigger with the chosen token and a space', () => {
    const trigger = triggerAt('look at @ap and', 11);
    expect(trigger).not.toBeNull();
    if (!trigger) return;
    expect(replaceTrigger('look at @ap and', trigger, '@src/app.ts')).toEqual({
      text: 'look at @src/app.ts  and',
      caret: 20,
    });
  });

  it('quotes labels with spaces and marks folders and lines', () => {
    expect(mentionToken({ kind: 'file', label: 'src/app.ts' })).toBe('@src/app.ts');
    expect(mentionToken({ kind: 'file', label: 'my notes.md' })).toBe('@"my notes.md"');
    expect(mentionToken({ kind: 'folder', label: 'src' })).toBe('@src/');
    expect(mentionToken({ kind: 'file', label: 'a.ts', lines: { start: 2, end: 2 } })).toBe(
      '@a.ts:L2',
    );
    expect(mentionToken({ kind: 'file', label: 'a.ts', lines: { start: 2, end: 9 } })).toBe(
      '@a.ts:L2-L9',
    );
  });

  it('sends only references whose token is still in the text, once each', () => {
    const file: MentionItem = {
      id: 'file:a',
      kind: 'file',
      label: 'a.ts',
      reference: { kind: 'file', path: 'a.ts' },
    };
    const result: MentionItem = {
      id: 'result:x',
      kind: 'result',
      label: 'report v2',
      reference: { kind: 'result', runId: 'run_1', artifactVersionId: 'av_1' },
    };
    const picked = [file, result, file];
    expect(pickedReferences('see @a.ts and @"report v2"', picked)).toEqual([
      file.reference,
      result.reference,
    ]);
    // The token was deleted: the reference goes with it.
    expect(pickedReferences('see @"report v2"', picked)).toEqual([result.reference]);
    // A longer path that only starts with the token is not the same reference.
    expect(pickedReferences('see @a.tsx', picked)).toEqual([]);
  });
});

describe('composer menu placement (#93)', () => {
  const input = { top: 600, bottom: 660, left: 40, width: 500 };
  it('opens above the input with its full height when the window has room', () => {
    expect(menuPlacement(input, 800)).toEqual({
      position: 'fixed',
      left: 40,
      width: 500,
      maxHeight: 288,
      bottom: 208,
    });
  });
  it('opens below a high input and shrinks to the room it has', () => {
    const placed = menuPlacement({ ...input, top: 60, bottom: 120 }, 400);
    expect(placed.top).toBe(128);
    expect(placed.bottom).toBeUndefined();
    expect(placed.maxHeight).toBe(264);
  });
  it('never collapses to nothing in a tiny window', () => {
    expect(menuPlacement({ ...input, top: 40, bottom: 80 }, 100).maxHeight).toBe(96);
  });
});
