import { describe, expect, it } from 'vitest';
import {
  composeCommentBody,
  parseCommentBody,
  quoteAt,
  rangeChanged,
  SUGGESTION_MARKERS,
} from './reviewComments.ts';

describe('review comment kinds', () => {
  it('keeps a plain comment as its own body', () => {
    const body = composeCommentBody({ kind: 'comment', note: 'Start with a title.' });
    expect(body).toBe('Start with a title.');
    expect(parseCommentBody(body)).toEqual({ kind: 'comment', note: 'Start with a title.' });
  });

  it('writes a deletion as the standard line and the quoted original', () => {
    const body = composeCommentBody({ kind: 'delete', original: 'old();\nmore();', note: '' });
    expect(body.split('\n')[0]).toBe(SUGGESTION_MARKERS.delete);
    expect(body).toContain('```original\nold();\nmore();\n```');
    expect(parseCommentBody(body)).toEqual({
      kind: 'delete',
      original: 'old();\nmore();',
      note: '',
    });
  });

  it('round-trips a replacement to its kind, original, replacement and note', () => {
    const draft = {
      kind: 'replace' as const,
      original: 'const a = `x`;\n```\nnot a fence end',
      replacement: 'const a = "y";',
      note: 'Use plain quotes.',
    };
    const body = composeCommentBody(draft);
    expect(body.split('\n')[0]).toBe(SUGGESTION_MARKERS.replace);
    // A fence longer than any backtick run in the text keeps the blocks unambiguous.
    expect(body).toContain('````original\n');
    expect(body).toContain('```replacement\nconst a = "y";\n```');
    expect(parseCommentBody(body)).toEqual(draft);
  });

  it('round-trips an empty original line', () => {
    const draft = { kind: 'replace' as const, original: '', replacement: 'added', note: '' };
    expect(parseCommentBody(composeCommentBody(draft))).toEqual(draft);
  });

  it('reads a marker without its blocks as an ordinary comment', () => {
    const body = `${SUGGESTION_MARKERS.replace}\nno blocks here`;
    expect(parseCommentBody(body)).toEqual({ kind: 'comment', note: body });
    const deletion = `${SUGGESTION_MARKERS.delete}\n\`\`\`replacement\nx\n\`\`\``;
    expect(parseCommentBody(deletion)).toEqual({ kind: 'comment', note: deletion });
  });
});

describe('range changed', () => {
  const comment = { side: 'after' as const, startLine: 2, endLine: 3, quote: 'b\nc' };

  it('is false while the current text at the range still matches the quote', () => {
    expect(rangeChanged(comment, { before: null, after: 'a\nb\nc\nd' })).toBe(false);
  });

  it('is true once the text at the range differs', () => {
    expect(rangeChanged(comment, { before: null, after: 'a\nb\nC\nd' })).toBe(true);
  });

  it('is true when the range no longer exists', () => {
    expect(rangeChanged(comment, { before: null, after: 'a\nb' })).toBe(true);
    expect(rangeChanged(comment, { before: null, after: '' })).toBe(true);
  });

  it('reads the side the comment quoted', () => {
    const before = { ...comment, side: 'before' as const };
    expect(rangeChanged(before, { before: 'a\nb\nc', after: 'x' })).toBe(false);
    expect(rangeChanged(before, { before: 'a\nx\nc', after: 'a\nb\nc' })).toBe(true);
  });

  it('is unknown when that side is not text', () => {
    expect(rangeChanged(comment, { before: 'a\nb\nc', after: null })).toBeNull();
  });

  it('quotes the lines of a range', () => {
    expect(quoteAt('a\nb\nc', 1, 2)).toBe('a\nb');
    expect(quoteAt('a\nb\nc', 3, 4)).toBeNull();
    expect(quoteAt('a', 0, 1)).toBeNull();
  });
});
