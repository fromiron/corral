// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { IntlProvider } from 'use-intl';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import messages from '../../../../packages/react/src/messages/en.json' with { type: 'json' };
import { PaddockSetupStatus } from './PaddockSetupStatus.tsx';

const fixture = vi.hoisted(() => ({
  setup: vi.fn(async (): Promise<unknown> => ({ output: { text: '' }, target: {} })),
}));
vi.mock('../services.tsx', () => ({
  useServices: () => ({ workspaces: { setup: fixture.setup } }),
}));

const disposals: (() => Promise<void>)[] = [];
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  fixture.setup.mockResolvedValue({ output: { text: '' }, target: {} });
});
afterEach(async () => {
  for (const dispose of disposals.splice(0)) await dispose();
  vi.unstubAllGlobals();
});

async function show() {
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
        <PaddockSetupStatus
          sessionId="session_a"
          setup={{ operationId: 'setup_1', state: 'failed' } as never}
          onChanged={() => {}}
        />
      </IntlProvider>,
    ),
  );
  return container;
}
const open = async (container: HTMLElement) => {
  const details = container.querySelector('details');
  if (!details) throw new Error('Missing output disclosure');
  await act(async () => {
    details.open = true;
    details.dispatchEvent(new Event('toggle'));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
};

// workbench.md: a failed read shows its cause and a way to try again.
it('says the setup output could not be read instead of calling it empty, and reads again', async () => {
  fixture.setup.mockRejectedValue(new Error('offline'));
  const container = await show();
  await open(container);
  expect(container.textContent).not.toContain('No output');
  expect(container.querySelector('[role="alert"]')?.textContent).toContain('offline');
  fixture.setup.mockResolvedValue({ output: { text: 'pnpm install: done' }, target: {} });
  const again = [...container.querySelectorAll('button')].find(
    (button) => button.textContent?.trim() === 'Try again',
  );
  if (!again) throw new Error('Missing Try again');
  await act(async () => {
    again.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  expect(container.querySelector('[role="alert"]')).toBeNull();
  expect(container.textContent).toContain('pnpm install: done');
});

it('still says No output when the command printed nothing', async () => {
  const container = await show();
  await open(container);
  expect(container.textContent).toContain('No output');
});
