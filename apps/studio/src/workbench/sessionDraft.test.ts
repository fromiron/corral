import { createTextAttachment } from '@corral/core';
import { describe, expect, it } from 'vitest';
import { parseComposerDraft, serializeComposerDraft } from './sessionDraft.ts';

// UX-02: a draft keeps its text, what it is for, and the exact things it references.

const result = {
  id: 'result:av_1',
  kind: 'result' as const,
  label: 'draft v1',
  reference: { kind: 'result' as const, runId: 'run_1', artifactVersionId: 'av_1' },
};

describe('composer draft (UX-02)', () => {
  it('[TC-CHAT-001-H] [TC-UX-02-H] keeps text, intent, target and references through storage', () => {
    const draft = {
      text: 'Compare with @"draft v1"',
      intent: 'steer' as const,
      target: 'exec_1',
      targetLabel: 'Research · #1',
      references: [result],
      attachments: [createTextAttachment('notes.txt', 'text/plain', 'Private body 한국어')],
      images: [
        {
          kind: 'image_attachment' as const,
          imageId: 'image_pixel',
          name: 'pixel.png',
          mime: 'image/png' as const,
          bytes: 70,
          sha256: 'a'.repeat(64),
          width: 1,
          height: 1,
        },
      ],
      taskScope: 'review_only' as const,
      verificationScope: 'release' as const,
      qualityPreset: 'ultra' as const,
      ultra: {
        version: 1 as const,
        modelProfiles: ['model-a', 'deepseek-hive'],
        verifierProfile: 'deepseek-hive',
      },
    };
    expect(parseComposerDraft(serializeComposerDraft(draft))).toEqual(draft);
  });

  it('[TC-UX-02-N] reads an older text-only draft as text', () => {
    expect(parseComposerDraft('Keep this purpose')).toEqual({
      text: 'Keep this purpose',
      intent: null,
      target: null,
      targetLabel: null,
      references: [],
    });
    expect(parseComposerDraft(null).text).toBe('');
    // A request that merely starts with a brace is text, not a broken draft.
    expect(parseComposerDraft('{ not json').text).toBe('{ not json');
  });

  it('[TC-UX-02-F] drops references and intents it cannot trust', () => {
    const stored = JSON.stringify({
      v: 2,
      text: 'x',
      intent: 'delete-everything',
      target: 7,
      references: [result, { id: 'x', kind: 'file' }, null, 'nope'],
    });
    expect(parseComposerDraft(stored)).toEqual({
      text: 'x',
      intent: null,
      target: null,
      targetLabel: null,
      references: [result],
    });
  });

  it('stores nothing for an empty draft', () => {
    expect(
      serializeComposerDraft({
        text: '',
        intent: null,
        target: null,
        targetLabel: null,
        references: [],
      }),
    ).toBeNull();
  });
});
