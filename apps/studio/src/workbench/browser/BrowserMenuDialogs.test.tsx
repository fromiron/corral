// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { IntlProvider } from 'use-intl';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import ko from '../../../../../packages/react/src/messages/ko.json' with { type: 'json' };
import { stubBrowser } from '../../pages/sessionShell.fixture.tsx';
import { SitePermissionsDialog } from './BrowserMenuDialogs.tsx';
import { createFakeBrowserBridge } from './fakeBrowserBridge.ts';

// A studio dialog's ✕ is named in the app's language, not the kit's English "Close".

vi.mock('../../services.tsx', () => ({ useServices: () => ({}) }));

const disposals: (() => Promise<void>)[] = [];
beforeEach(() => {
  const restore = stubBrowser();
  disposals.push(async () => restore());
});
afterEach(async () => {
  for (const dispose of disposals.splice(0).reverse()) await dispose();
  vi.unstubAllGlobals();
});

it('한국어에서 대화상자의 ✕는 "닫기"라는 이름이다 (반례: 킷의 영어 "Close")', async () => {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  disposals.push(async () => {
    await act(async () => root.unmount());
    container.remove();
  });
  await act(async () => {
    root.render(
      <IntlProvider locale="ko" messages={ko} timeZone="UTC">
        <SitePermissionsDialog
          bridge={createFakeBrowserBridge()}
          projectId="project_a"
          origin="https://meet.example"
          onClose={() => {}}
        />
      </IntlProvider>,
    );
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  const dialog = document.querySelector('[role="dialog"]');
  const names = [...(dialog?.querySelectorAll('button') ?? [])].map(
    (button) => button.getAttribute('aria-label') ?? button.textContent?.trim(),
  );
  expect(names).toContain(ko.Common.close);
  expect(names).not.toContain('Close');
});
