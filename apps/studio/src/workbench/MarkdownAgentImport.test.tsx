// @vitest-environment jsdom
import { createEditorStore } from '@corral/react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { IntlProvider } from 'use-intl';
import { afterEach, expect, it, vi } from 'vitest';
import messages from '../../../../packages/react/src/messages/en.json' with { type: 'json' };
import { MarkdownAgentImport } from './MarkdownAgentImport.tsx';

vi.mock('../services.tsx', () => ({ useServices: () => ({ harnesses: {} }) }));

const disposals: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const dispose of disposals.splice(0)) await dispose();
  vi.unstubAllGlobals();
});

it('opens from a compact button, the same size as the editor head controls beside it', async () => {
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
        <MarkdownAgentImport editor={createEditorStore()} profiles={[]} projectId="default" />
      </IntlProvider>,
    ),
  );
  const trigger = [...container.querySelectorAll('button')].find(
    (button) => button.textContent === 'Import Markdown agent',
  );
  // Export JSON, Test run and Save in the head are all compact buttons.
  expect(trigger?.dataset.size).toBe('compact');
});
