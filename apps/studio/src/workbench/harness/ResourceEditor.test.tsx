// @vitest-environment jsdom
import type { HarnessApi } from '@corral/client';
import type { HarnessDocumentDraft, HarnessEntryView } from '@corral/contracts';
import { Dialog, DialogPopup } from '@corral/react/design-kit';
import { act, createRef } from 'react';
import { createRoot } from 'react-dom/client';
import { IntlProvider } from 'use-intl';
import { afterEach, expect, it, vi } from 'vitest';
import en from '../../../../../packages/react/src/messages/en.json' with { type: 'json' };
import { ResourceEditor } from './ResourceEditor.tsx';

const confirmLeave = vi.hoisted(() => vi.fn(async (_form: { dirty: boolean }) => true));

vi.mock('../../desktop.tsx', () => ({ desktop: null }));
vi.mock('../SettingsLifecycle.tsx', () => ({
  useSettingsForm: (form: { dirty: boolean }) => () => confirmLeave(form),
  useSettingsTask: () => async (task: () => Promise<unknown>) => task(),
}));

const disposals: (() => Promise<void>)[] = [];
Element.prototype.getAnimations ??= () => [];
afterEach(async () => {
  for (const dispose of disposals.splice(0)) await dispose();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

type RenderOptions = {
  entry?: HarnessEntryView;
  importing?: boolean;
  embedded?: boolean;
  onClose?: () => void;
  onSaved?: (hash: string, path?: string) => void;
};

async function render(api: HarnessApi, options: RenderOptions = {}) {
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
  const backRef = createRef<(event?: Event) => void>();
  const editor = (
    <ResourceEditor
      api={api}
      kind="skill"
      onClose={() => {}}
      onSaved={() => {}}
      {...options}
      backRef={backRef}
    />
  );
  await act(async () =>
    root.render(
      <IntlProvider locale="en" messages={en}>
        {options.embedded ? (
          <Dialog
            open
            onOpenChange={(open, details) => {
              if (!open) {
                details.cancel();
                backRef.current?.(details.event);
              }
            }}
          >
            <DialogPopup aria-label={en.Resources.createSkill} showCloseButton={false}>
              {editor}
            </DialogPopup>
          </Dialog>
        ) : (
          editor
        )}
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

const button = (dialog: Element, label: string) => {
  const control = [...dialog.querySelectorAll('button')].find((node) => node.textContent === label);
  if (!control) throw new Error(`Missing ${label}`);
  return control;
};

function creationApi() {
  return {
    reviewDocument: vi.fn(async (value: HarnessDocumentDraft) => {
      expect(value.name).toBe('Security review');
      expect(value.content).toMatch(/^name: skill-/m);
      expect(value.content).toContain('Inspect the diff.');
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
    install: vi.fn(async () => ({ hash: 'installed-hash' })),
    trust: vi.fn(async () => ({})),
  };
}

async function createForm(api: ReturnType<typeof creationApi>, options?: RenderOptions) {
  const dialog = await render(api as unknown as HarnessApi, options);
  await fill(dialog, 'Display name', 'Security review');
  await fill(dialog, en.Resources.description, 'Review safely');
  await fill(dialog, en.Resources.instructions, 'Inspect the diff.');
  return dialog;
}

it('saves a skill with one Save; installing makes it usable without a trust call', async () => {
  const api = creationApi();
  const onSaved = vi.fn();
  const dialog = await createForm(api, { embedded: true, onSaved });
  expect(dialog.textContent).not.toContain('Save and trust');
  expect(dialog.textContent).not.toContain('Save without trust');
  await act(async () => button(dialog, en.Resources.save).click());
  expect(api.install).toHaveBeenCalledExactlyOnceWith('review_new');
  expect(api.trust).not.toHaveBeenCalled();
  expect(onSaved).toHaveBeenCalledExactlyOnceWith('installed-hash', 'skills/SKILL.md');
});

it('opens a named create step and focuses its first input without stacking a dialog', async () => {
  const dialog = await render(creationApi() as unknown as HarnessApi, { embedded: true });
  expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(1);
  expect(document.querySelectorAll('[data-slot="dialog-backdrop"]')).toHaveLength(1);
  const step = dialog.querySelector('section[aria-labelledby]');
  const heading = document.getElementById(step?.getAttribute('aria-labelledby') ?? '');
  expect(heading?.textContent).toBe(en.Resources.createSkill);
  expect(document.activeElement).toBe(step?.querySelector('input'));
});

it('guards the draft on Back and on Escape targeted at the picker popup', async () => {
  const onClose = vi.fn();
  const api = creationApi();
  const dialog = await createForm(api, { embedded: true, onClose });
  confirmLeave.mockResolvedValueOnce(false);
  await act(async () => button(dialog, en.Library.back).click());
  expect(confirmLeave).toHaveBeenCalledWith(expect.objectContaining({ dirty: true }));
  expect(onClose).not.toHaveBeenCalled();
  expect(dialog.querySelector('input')?.value).toBe('Security review');
  await act(async () =>
    dialog.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })),
  );
  expect(confirmLeave).toHaveBeenCalledTimes(2);
  expect(onClose).toHaveBeenCalledTimes(1);
  expect(api.install).not.toHaveBeenCalled();
});

it('does not navigate or submit while confirming IME input', async () => {
  const onClose = vi.fn();
  const api = creationApi();
  const dialog = await createForm(api, { embedded: true, onClose });
  const name = dialog.querySelector('input');
  if (!name) throw new Error('Name input missing');
  for (const ime of [{ isComposing: true }, { keyCode: 229 }]) {
    const enter = new KeyboardEvent('keydown', {
      key: 'Enter',
      bubbles: true,
      cancelable: true,
      ...ime,
    });
    await act(async () => name.dispatchEvent(enter));
    expect(enter.defaultPrevented).toBe(true);
    await act(async () =>
      dialog.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, ...ime })),
    );
  }
  expect(confirmLeave).not.toHaveBeenCalled();
  expect(onClose).not.toHaveBeenCalled();
  expect(api.install).not.toHaveBeenCalled();
});

it('does not review, install or trust a creation cancelled before save', async () => {
  const api = creationApi();
  const dialog = await createForm(api);
  await act(async () => button(dialog, 'Cancel').click());
  expect(api.reviewDocument).not.toHaveBeenCalled();
  expect(api.install).not.toHaveBeenCalled();
  expect(api.trust).not.toHaveBeenCalled();
});

it('keeps the fields on install failure and saves on retry', async () => {
  const api = creationApi();
  api.install.mockRejectedValueOnce(new Error('unavailable'));
  const onSaved = vi.fn();
  const dialog = await createForm(api, { onSaved });
  await act(async () => button(dialog, en.Resources.save).click());
  expect(dialog.querySelector('[role="alert"]')).toBeTruthy();
  expect(onSaved).not.toHaveBeenCalled();
  expect(dialog.querySelector('input')?.value).toBe('Security review');
  expect(dialog.querySelector('textarea')?.value).toBe('Inspect the diff.');
  await act(async () => button(dialog, en.Resources.save).click());
  expect(api.install).toHaveBeenCalledTimes(2);
  expect(api.trust).not.toHaveBeenCalled();
  expect(onSaved).toHaveBeenCalledExactlyOnceWith('installed-hash', 'skills/SKILL.md');
});

it('imports the reviewed entries and files without a trust action', async () => {
  const skills = ['one', 'two'].map((name) => ({
    name,
    description: name,
    entry: `skills/${name}/SKILL.md`,
  }));
  const api = {
    review: vi.fn(async () => ({
      reviewId: 'pack',
      resource: {
        skills,
        extensions: [],
        files: skills.map((s) => ({ path: s.entry, bytes: 15 })),
      },
    })),
    install: vi.fn(async () => ({ hash: 'bundle', skills })),
    cancelReview: vi.fn(async () => ({})),
    trust: vi.fn(),
  };
  const dialog = await render(api as unknown as HarnessApi, { importing: true });
  const summary = await review(dialog);
  expect(api.review).toHaveBeenCalledWith('builtin', 'core');
  expect(summary.querySelectorAll(':scope > ul > li')).toHaveLength(2);
  expect(summary.querySelector('details')?.textContent).toContain('skills/two/SKILL.md');
  expect(dialog.textContent).not.toContain('Save and trust');
  await act(async () => button(dialog, 'Save to library').click());
  expect(api.install).toHaveBeenCalledExactlyOnceWith('pack');
  expect(api.trust).not.toHaveBeenCalled();
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
  const dialog = await render(api, { entry });
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
