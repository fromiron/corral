// @vitest-environment jsdom
import type { HarnessApi } from '@corral/client';
import type { HarnessDocumentDraft, HarnessEntryView } from '@corral/contracts';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { IntlProvider } from 'use-intl';
import { afterEach, expect, it, vi } from 'vitest';
import en from '../../../../../packages/react/src/messages/en.json' with { type: 'json' };
import { ResourceEditor } from './ResourceEditor.tsx';

vi.mock('../../desktop.tsx', () => ({ desktop: null }));
vi.mock('../SettingsLifecycle.tsx', () => ({
  useSettingsForm: () => async () => true,
  useSettingsTask: () => async (task: () => Promise<unknown>) => task(),
}));

const disposals: (() => Promise<void>)[] = [];
Element.prototype.getAnimations ??= () => [];
afterEach(async () => {
  for (const dispose of disposals.splice(0)) await dispose();
  vi.unstubAllGlobals();
});

async function render(api: HarnessApi, entry?: HarnessEntryView) {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('matchMedia', () => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  }));
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
      unobserve() {}
    },
  );
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  disposals.push(async () => {
    await act(async () => root.unmount());
    container.remove();
  });
  await act(async () =>
    root.render(
      <IntlProvider locale="en" messages={en}>
        <ResourceEditor
          api={api}
          kind="skill"
          entry={entry}
          onClose={() => {}}
          onSaved={() => {}}
        />
      </IntlProvider>,
    ),
  );
  const dialog = document.querySelector('[role="dialog"]');
  if (!dialog) throw new Error('Resource editor missing');
  return dialog;
}

async function fill(dialog: Element, label: string, value: string) {
  const field = [...dialog.querySelectorAll('label')]
    .find((node) => node.textContent?.startsWith(label))
    ?.querySelector('input, textarea');
  if (!field) throw new Error(`Field missing: ${label}`);
  const prototype =
    field instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
  await act(async () => {
    Object.getOwnPropertyDescriptor(prototype, 'value')?.set?.call(field, value);
    field.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function review(dialog: Element) {
  const form = dialog.querySelector('form');
  if (!form) throw new Error('Resource form missing');
  await act(async () =>
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })),
  );
  const summary = dialog.querySelector('section[aria-label="Review source"]');
  if (!summary) throw new Error('Review summary missing');
  return summary;
}

it('shows the entered name for a new skill while retaining its generated frontmatter name', async () => {
  let draft: HarnessDocumentDraft | undefined;
  const api = {
    reviewDocument: vi.fn(async (value: HarnessDocumentDraft) => {
      draft = value;
      return {
        reviewId: 'review_new',
        resource: {
          skills: [
            {
              name: value.content.match(/^name: (.+)$/m)?.[1],
              description: 'Review safely',
              entry: 'skills/SKILL.md',
            },
          ],
          extensions: [],
          files: [{ path: 'skills/SKILL.md', bytes: value.content.length }],
        },
      };
    }),
    cancelReview: vi.fn(async () => {}),
  } as unknown as HarnessApi;
  const dialog = await render(api);
  await fill(dialog, 'Display name', 'Security review');
  await fill(dialog, en.Resources.description, 'Review safely');
  await fill(dialog, en.Resources.instructions, 'Inspect the diff and preserve the evidence.');
  const summary = await review(dialog);
  const internalName = draft?.content.match(/^name: (.+)$/m)?.[1];
  expect(internalName).toMatch(/^skill-/);
  expect(draft?.name).toBe('Security review');
  expect(summary.querySelector('ul')?.textContent).toBe('Security review — Review safely');
  expect(summary.querySelector('details')?.open).toBe(false);
  expect(summary.querySelector('details')?.textContent).toContain(internalName);
  expect(draft?.content).toContain('Inspect the diff and preserve the evidence.');
});

it('renames only the edited skill in a multi-skill review and leaves its source unchanged', async () => {
  const content =
    '---\nname: second-internal\ndescription: Second skill\n---\nOriginal instructions.';
  const reviewDocument = vi.fn(async () => ({
    reviewId: 'review_copy',
    resource: {
      skills: [
        { name: 'first-internal', description: 'First skill', entry: 'skills/first/SKILL.md' },
        { name: 'second-internal', description: 'Second skill', entry: 'skills/second/SKILL.md' },
      ],
      extensions: [],
      files: [
        { path: 'skills/first/SKILL.md', bytes: 40 },
        { path: 'skills/second/SKILL.md', bytes: content.length },
      ],
    },
  }));
  const api = {
    readEntry: async () => ({ content, hook: null }),
    reviewDocument,
    cancelReview: vi.fn(async () => {}),
  } as unknown as HarnessApi;
  const entry = {
    resourceHash: 'a'.repeat(64),
    entry: 'skills/second/SKILL.md',
    kind: 'skill',
    name: 'Earlier display name',
  } as HarnessEntryView;
  const dialog = await render(api, entry);
  await fill(dialog, 'Display name', 'Updated display name');
  const summary = await review(dialog);
  expect(reviewDocument).toHaveBeenCalledWith({
    kind: 'skill',
    name: 'Updated display name',
    content,
    base: { resourceHash: entry.resourceHash, entry: entry.entry, kind: 'skill' },
  });
  expect([...summary.querySelectorAll(':scope > ul > li')].map((node) => node.textContent)).toEqual(
    ['first-internal — First skill', 'Updated display name — Second skill'],
  );
  expect(summary.querySelector('details')?.textContent).toContain('second-internal');
});
