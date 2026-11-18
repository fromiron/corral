// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { IntlProvider } from 'use-intl';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import messages from '../../../../packages/react/src/messages/en.json' with { type: 'json' };
import { type PreviewTabs, PreviewTabsContext } from './browser/previewTabs.tsx';
import { FilePreview } from './FilePreview.tsx';

// A previewable file's own static lease (features/browser-tab.md 여는 곳): where the desktop's
// browser tab is, "Open interactive preview" opens that lease in a preview tab and the lease stays
// this preview's; elsewhere on the desktop it opens the separate preview window.

const fixture = vi.hoisted(() => ({
  desktop: { openPreview: vi.fn(async () => {}) } as { openPreview: () => Promise<void> } | null,
  workspaces: {
    startPreview: vi.fn(async (sessionId: string) => ({
      leaseId: 'lease_file',
      sessionId,
      kind: 'static' as const,
      url: 'http://127.0.0.2:4100/lease_file/index.html',
      origin: 'http://127.0.0.2:4100',
      path: '/index.html',
      state: 'ready' as const,
      createdAt: '2026-11-18T00:00:00Z',
    })),
    stopPreview: vi.fn(async () => {}),
  },
}));
vi.mock('../services.tsx', () => ({ useServices: () => ({ workspaces: fixture.workspaces }) }));
vi.mock('../desktop.tsx', () => ({
  get previewDesktop() {
    return fixture.desktop;
  },
}));

const disposals: (() => Promise<void>)[] = [];
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  fixture.desktop = { openPreview: vi.fn(async () => {}) };
  fixture.workspaces.startPreview.mockClear();
  fixture.workspaces.stopPreview.mockClear();
});
afterEach(async () => {
  for (const dispose of disposals.splice(0)) await dispose();
  vi.unstubAllGlobals();
});

async function render(tabs: PreviewTabs | null) {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const unmount = async () => {
    await act(async () => root.unmount());
    container.remove();
  };
  disposals.push(unmount);
  await act(async () => {
    root.render(
      <IntlProvider locale="en" messages={messages} timeZone="UTC">
        <PreviewTabsContext.Provider value={tabs}>
          <FilePreview sessionId="session_a" path="index.html" />
        </PreviewTabsContext.Provider>
      </IntlProvider>,
    );
  });
  return container;
}
const button = (container: HTMLElement, name: string) =>
  [...container.querySelectorAll('button')].find(
    (item) => (item.getAttribute('aria-label') ?? item.textContent?.trim()) === name,
  ) ?? null;
async function openLease(container: HTMLElement) {
  await act(async () => button(container, messages.Preview.open)?.click());
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

it('브라우저 탭이 있으면 "대화형 미리보기 열기"는 그 lease를 미리보기 탭으로 열고, 따로 뜨는 창은 열지 않으며 lease를 멈추지 않는다', async () => {
  const open = vi.fn(() => true);
  const container = await render({ open });
  await openLease(container);
  await act(async () => button(container, messages.Preview.openInteractive)?.click());

  expect(open.mock.calls).toEqual([['lease_file']]);
  expect(fixture.desktop?.openPreview).not.toHaveBeenCalled();
  expect(fixture.workspaces.stopPreview).not.toHaveBeenCalled();
});

it('브라우저 탭이 없는 데스크톱(원격 호스트의 창)에서는 지금처럼 따로 뜨는 미리보기 창으로 연다 (반례)', async () => {
  const container = await render(null);
  await openLease(container);
  await act(async () => button(container, messages.Preview.openInteractive)?.click());

  expect(fixture.desktop?.openPreview).toHaveBeenCalledWith('session_a', 'lease_file');
});

it('웹 모드(데스크톱이 없음)에는 대화형 미리보기 열기가 없고 iframe만 보인다 (반례)', async () => {
  fixture.desktop = null;
  const container = await render(null);
  await openLease(container);

  expect(button(container, messages.Preview.openInteractive)).toBeNull();
  expect(container.querySelector('[data-testid="file-preview-frame"]')).not.toBeNull();
});
