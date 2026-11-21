// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { IntlProvider } from 'use-intl';
import { expect, it, vi } from 'vitest';
import messages from '../../../../packages/react/src/messages/en.json' with { type: 'json' };
import { WorkFolderSection } from './FilesViews.tsx';

const fixture = vi.hoisted(() => ({ binding: null as unknown }));
vi.mock('../services.tsx', () => {
  const workspaces = { binding: async () => fixture.binding };
  return { useServices: () => ({ workspaces, mode: 'server' }) };
});
vi.mock('../workbench/SettingsLifecycle.tsx', () => ({
  useSettingsForm: () => {},
  useSettingsTask: () => (work: () => Promise<unknown>) => work(),
}));

const LONG = `/home/someone/projects/${'a-very-long-folder-name/'.repeat(4)}and-the-repository-itself`;

async function render() {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  await act(async () =>
    root.render(
      <IntlProvider locale="en" messages={messages} timeZone="UTC">
        <WorkFolderSection projectId="project" />
      </IntlProvider>,
    ),
  );
  return {
    container,
    async unmount() {
      await act(async () => root.unmount());
      container.remove();
      vi.unstubAllGlobals();
    },
  };
}

it('a long typed path truncates in its block instead of pushing the path field and the link button out of the row', async () => {
  fixture.binding = null;
  const { container, unmount } = await render();
  try {
    const field = container.querySelector<HTMLInputElement>(
      `input[aria-label="${messages.Files.pathLabel}"]`,
    );
    if (!field) throw new Error('path field expected');
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(field, LONG);
      field.dispatchEvent(new Event('input', { bubbles: true }));
    });

    const echo = container.querySelector(`p[title="${LONG}"]`);
    if (!echo) throw new Error('the typed path is echoed');
    // The echo ends in an ellipsis, and the block holding it may shrink below the path's width.
    expect(echo.classList.contains('truncate')).toBe(true);
    const block = echo.parentElement;
    expect(block?.parentElement?.classList.contains('settings-row')).toBe(true);
    expect(block?.classList.contains('min-w-0')).toBe(true);
  } finally {
    await unmount();
  }
});

// A linked folder's path is the row's content: it stays whole and wraps, breaking inside a
// segment only where the segment cannot fit, so it never pushes the unlink button out.
const UNBROKEN = `/home/someone/${'x'.repeat(230)}`;

it('a linked folder with a long unbroken path wraps whole in its block instead of pushing the unlink button out of the row', async () => {
  fixture.binding = {
    path: UNBROKEN,
    trusted: false,
    missing: true,
    isGit: false,
    status: null,
    verifyCommands: [],
  };
  const { container, unmount } = await render();
  try {
    const path = container.querySelector(`p[title="${UNBROKEN}"]`);
    if (!path) throw new Error('the linked path is shown');
    expect(path.classList.contains('truncate')).toBe(false);
    const block = path.parentElement;
    expect(block?.parentElement?.classList.contains('settings-row')).toBe(true);
    // The rule sits on the block, so the missing-folder alert that repeats the path wraps too.
    expect(block?.querySelector('[role="alert"]')?.textContent).toContain(UNBROKEN);
    expect(block?.classList.contains('min-w-0')).toBe(true);
    expect(block?.classList.contains('wrap-anywhere')).toBe(true);
    expect(block?.classList.contains('break-all')).toBe(false);
  } finally {
    await unmount();
  }
});
