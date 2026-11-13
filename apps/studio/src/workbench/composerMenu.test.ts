import type { RunReference } from '@corral/contracts';
import { describe, expect, it } from 'vitest';
import {
  type MentionItem,
  mentionToken,
  menuPlacement,
  pickedReferences,
  removeMention,
  replaceTrigger,
  restoredMentions,
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

// A saved request's references come back as chips bound to their own tokens
// (features/composer-flow.md "대기 요청과 넘겨받기").
describe('restored references', () => {
  const run: RunReference = { kind: 'run', runId: 'run_two' };
  const role: RunReference = { kind: 'role', roleId: 'writer' };
  const file: RunReference = { kind: 'file', path: 'src/a.ts', lines: { start: 2, end: 4 } };
  const resultOf = (id: string): RunReference => ({
    kind: 'result',
    runId: 'run_one',
    artifactVersionId: id,
  });
  const names = {
    run: (runId: string) => (runId === 'run_two' ? 'Run #2' : null),
    role: (roleId: string) => (roleId === 'writer' ? 'Writer' : null),
  };
  const tokenOf = (items: MentionItem[], reference: RunReference) => {
    const item = items.find(
      (value) => JSON.stringify(value.reference) === JSON.stringify(reference),
    );
    return item ? mentionToken(item) : null;
  };

  it('binds a run and a role by their names, whatever order they were picked in', () => {
    const text = 'For @Writer read @"Run #2" first';
    const items = restoredMentions(text, [run, role], names);
    expect(tokenOf(items, role)).toBe('@Writer');
    expect(tokenOf(items, run)).toBe('@"Run #2"');
    expect(pickedReferences(text, items)).toEqual([run, role]);
  });

  it('leaves a word that names nothing as text', () => {
    const text = 'Ask @bob, then @Writer';
    const items = restoredMentions(text, [role], names);
    expect(items).toHaveLength(1);
    expect(tokenOf(items, role)).toBe('@Writer');
    // A run or role whose name is not known is not made a chip from another word.
    expect(
      restoredMentions('Ask @bob now', [role, run], { run: () => null, role: () => null }),
    ).toEqual([]);
  });

  it('never gives a new result the number of one removed, so the numbers keep the picked order', () => {
    const item = (id: string): MentionItem => ({
      id: `result:${id}`,
      kind: 'result',
      label: `${id} v1`,
      reference: resultOf(id),
    });
    const a = selectMention(item('a'), []);
    const b = selectMention(item('b'), [a]);
    // The first is removed before the third is picked.
    const c = selectMention(item('c'), [b]);
    expect([mentionToken(a), mentionToken(b), mentionToken(c)]).toEqual([
      '@result:1',
      '@result:2',
      '@result:3',
    ]);
    // Saved in the picked order, they come back to their own numbers, wherever the text puts them.
    const text = 'Compare @result:3 with @result:2';
    const items = restoredMentions(text, [resultOf('b'), resultOf('c')], names);
    expect(tokenOf(items, resultOf('b'))).toBe('@result:2');
    expect(tokenOf(items, resultOf('c'))).toBe('@result:3');
    expect(pickedReferences(text, items)).toEqual([resultOf('b'), resultOf('c')]);
  });

  it('a path named twice is one chip, and two ranges of one path are two', () => {
    const text = 'See @src/a.ts:L2-L4 and again @src/a.ts:L2-L4 then @src/a.ts:L9';
    const other: RunReference = { kind: 'file', path: 'src/a.ts', lines: { start: 9, end: 9 } };
    const items = restoredMentions(text, [file, other], names);
    expect(items).toHaveLength(2);
    expect(tokenOf(items, file)).toBe('@src/a.ts:L2-L4');
    expect(tokenOf(items, other)).toBe('@src/a.ts:L9');
    expect(pickedReferences(text, items)).toEqual([file, other]);
  });

  it('removing one restored chip, or its word, drops only that reference', () => {
    const text = 'For @Writer read @"Run #2" and @src/a.ts:L2-L4';
    const all = [run, role, file];
    const items = restoredMentions(text, all, names);
    expect(items).toHaveLength(3);
    const words: [RunReference, string][] = [
      [role, '@Writer'],
      [run, '@"Run #2"'],
      [file, '@src/a.ts:L2-L4'],
    ];
    for (const [reference, word] of words) {
      const item = items.find(
        (value) => JSON.stringify(value.reference) === JSON.stringify(reference),
      );
      if (!item) throw new Error('chip missing');
      const others = all.filter((value) => value !== reference);
      expect(pickedReferences(removeMention(text, item, items), items)).toEqual(others);
      expect(pickedReferences(text.replace(word, ''), items)).toEqual(others);
    }
  });
});
