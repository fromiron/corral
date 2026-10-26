// @vitest-environment jsdom
import type { WorkSession } from '@corral/core';
import { act, type ButtonHTMLAttributes, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import type { ReviewSearch } from './panels/routes.ts';
import { SessionChangesPanel } from './SessionChangesPanel.tsx';

vi.mock('use-intl', () => ({ useTranslations: () => (key: string) => key }));
vi.mock('@corral/react/design-kit', () => ({
  Button: ({
    variant: _,
    size: __,
    ...props
  }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: string; size?: string }) => (
    <button {...props} />
  ),
}));
vi.mock('../pages/FilesViews.tsx', () => ({
  WorkingCopyPanel: () => <span>copy preparation</span>,
}));
vi.mock('./GitPanel.tsx', () => ({ GitPanel: () => <input aria-label="commit message" /> }));
vi.mock('../pages/ReviewPage.tsx', () => ({
  ReviewContent: ({ onPrepareCopy }: { onPrepareCopy?: () => void }) => (
    <div>
      <textarea aria-label="review draft" />
      <button type="button" onClick={onPrepareCopy}>
        prepare copy
      </button>
    </div>
  ),
}));

it('keeps commit and review drafts when moving between Git, review and copy preparation', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  try {
    function Fixture() {
      const [search, setSearch] = useState<ReviewSearch>();
      return (
        <SessionChangesPanel
          session={{ sessionId: 'session', projectId: 'project' } as WorkSession}
          reviewSearch={search}
          onReviewChange={setSearch}
        />
      );
    }
    await act(async () => root.render(<Fixture />));
    const commit = container.querySelector<HTMLInputElement>('input');
    if (!commit) throw new Error('Missing commit input');
    commit.value = 'retain my commit message';
    const button = (label: string) =>
      [...container.querySelectorAll('button')].find((item) => item.textContent === label);
    expect(button('reviewFeedback')).toBeDefined();
    await act(async () => button('reviewFeedback')?.click());
    const draft = container.querySelector<HTMLTextAreaElement>('textarea');
    if (!draft) throw new Error('Missing review draft');
    draft.value = 'retain my review';
    await act(async () => button('backToGit')?.click());
    expect(container.querySelector('input')).toBe(commit);
    expect(commit.value).toBe('retain my commit message');
    await act(async () => button('reviewFeedback')?.click());
    expect(container.querySelector('textarea')).toBe(draft);
    expect(draft.value).toBe('retain my review');
    await act(async () => button('prepare copy')?.click());
    expect(button('reviewFeedback')).toBeDefined();
    expect(container.querySelector('input')).toBe(commit);
  } finally {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  }
});
