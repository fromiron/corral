// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { IntlProvider } from 'use-intl';
import { afterEach, expect, it, vi } from 'vitest';
import messages from '../../../../packages/react/src/messages/en.json' with { type: 'json' };
import {
  PREVIEW_FEATURES,
  PreviewPage,
  previewFeature,
  validatePreviewSearch,
} from './PreviewPage.tsx';

const disposals: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const dispose of disposals.splice(0)) await dispose();
  vi.unstubAllGlobals();
});

async function render(feature?: string) {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  disposals.push(async () => {
    await act(async () => root.unmount());
    container.remove();
  });
  await act(async () =>
    root.render(
      <IntlProvider locale="en" messages={messages} timeZone="UTC">
        <PreviewPage feature={feature} />
      </IntlProvider>,
    ),
  );
  return container;
}

it('knows only the three sample flows', () => {
  expect(PREVIEW_FEATURES).toEqual(['task-board', 'pr-review', 'browser-qa']);
  for (const feature of PREVIEW_FEATURES) expect(previewFeature(feature)).toBe(feature);
  for (const other of ['', 'Task-Board', 'task-board ', 'settings', 'toString', undefined, 1])
    expect(previewFeature(other)).toBeUndefined();
});

it('keeps only an in-app return address', () => {
  expect(validatePreviewSearch({ returnTo: '/projects/project_a' })).toEqual({
    returnTo: '/projects/project_a',
  });
  for (const returnTo of ['https://example.org', '//example.org', '/settings', 'projects'])
    expect(validatePreviewSearch({ returnTo })).toEqual({});
});

it('shows a known feature, and the list for anything else', async () => {
  const feature = await render('pr-review');
  expect(feature.querySelector('h2')?.textContent).toBe('Feature previews');
  expect(feature.querySelector('main')?.dataset.previewFeature).toBe('pr-review');
  for (const other of [undefined, 'unknown', 'toString']) {
    const list = await render(other);
    expect(list.querySelector('h2')?.textContent).toBe('Feature previews');
    expect(list.querySelector('main')?.dataset.previewFeature).toBeUndefined();
  }
});
