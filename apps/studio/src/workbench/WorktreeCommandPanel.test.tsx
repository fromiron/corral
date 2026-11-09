// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { IntlProvider } from 'use-intl';
import { expect, it, vi } from 'vitest';
import messages from '../../../../packages/react/src/messages/en.json' with { type: 'json' };
import { WorktreeCommandPanel } from './WorktreeCommandPanel.tsx';

const fixture = vi.hoisted(() => ({ workspaces: {} as Record<string, unknown> }));
vi.mock('../services.tsx', () => ({
  useServices: () => ({ mode: 'server', workspaces: fixture.workspaces }),
}));

it('retains the full command tooltip on each selectable history entry', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const first = 'pnpm exec tsc --project tsconfig.json --pretty false';
  const second = 'pnpm exec vitest run --project studio --maxWorkers=4';
  fixture.workspaces = {
    commands: vi.fn(async () => [
      { id: 'first', command: first, state: 'completed' },
      { id: 'second', command: second, state: 'completed' },
    ]),
    commandReport: vi.fn(async () => ({ state: 'completed' })),
    commandOutput: vi.fn(async () => ({ text: '', bytes: 0, truncated: false })),
  };
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () =>
      root.render(
        <IntlProvider locale="en" messages={messages} timeZone="UTC">
          <WorktreeCommandPanel sessionId="session" />
        </IntlProvider>,
      ),
    );
    const history = container.querySelector(`[aria-label="${messages.Processes.history}"]`);
    const buttons = [...(history?.querySelectorAll('button') ?? [])];
    expect(buttons.map((button) => button.getAttribute('title'))).toEqual([first, second]);
    await act(async () => buttons[1]?.click());
    expect(buttons[1]?.getAttribute('aria-pressed')).toBe('true');
  } finally {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  }
});
