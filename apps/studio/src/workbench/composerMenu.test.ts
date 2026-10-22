import { describe, expect, it } from 'vitest';
import {
  type MentionItem,
  mentionToken,
  menuPlacement,
  pickedReferences,
  replaceTrigger,
  triggerAt,
} from './composerMenu.ts';

// CR-016: the composer's `/` commands and `@` references.

describe('composer triggers (CR-016)', () => {
  it('[TC-REF-020-H] opens commands only for `/` at the very start', () => {
    expect(triggerAt('/pa', 3)).toEqual({ kind: 'slash', query: 'pa', start: 0, end: 3 });
    expect(triggerAt('/', 1)).toEqual({ kind: 'slash', query: '', start: 0, end: 1 });
    expect(triggerAt('see a/b', 7)).toBeNull();
    expect(triggerAt('text /pa', 8)).toBeNull();
    expect(triggerAt('/pause now', 10)).toBeNull();
  });

  it('[TC-REF-021-H] opens references for `@` after a space or at the start', () => {
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

  it('[TC-REF-022-H] replaces the trigger with the chosen token and a space', () => {
    const trigger = triggerAt('look at @ap and', 11);
    expect(trigger).not.toBeNull();
    if (!trigger) return;
    expect(replaceTrigger('look at @ap and', trigger, '@src/app.ts')).toEqual({
      text: 'look at @src/app.ts  and',
      caret: 20,
    });
  });

  it('[TC-REF-023-H] quotes labels with spaces and marks folders and lines', () => {
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

  it('[TC-REF-024-H] sends only references whose token is still in the text, once each', () => {
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
