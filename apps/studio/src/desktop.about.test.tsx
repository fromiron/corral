// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { IntlProvider } from 'use-intl';
import { afterEach, expect, it, vi } from 'vitest';
import messages from '../../../packages/react/src/messages/en.json' with { type: 'json' };
import { DesktopAbout } from './desktop.tsx';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const undo of cleanup.splice(0)) await undo();
  vi.unstubAllGlobals();
});

async function version(serverVersion: string) {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  cleanup.push(async () => {
    await act(async () => root.unmount());
    container.remove();
  });
  await act(async () =>
    root.render(
      <IntlProvider locale="en" messages={messages}>
        <DesktopAbout serverVersion={serverVersion} />
      </IntlProvider>,
    ),
  );
  const row = container.querySelector('section');
  return {
    heading: row?.querySelector('h3')?.textContent,
    value: row?.querySelector('p')?.textContent,
  };
}

it('writes the version once: the row’s name, then the version or the development build', async () => {
  expect(await version('1.4.0')).toEqual({ heading: messages.Desktop.version, value: '1.4.0' });
  expect(await version('0.0.0')).toEqual({
    heading: messages.Desktop.version,
    value: messages.Desktop.developmentBuild,
  });
});
