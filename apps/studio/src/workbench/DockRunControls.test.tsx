// @vitest-environment jsdom
import { emptyProjection, type RuntimeTransport } from '@corral/core';
import { createRunSession } from '@corral/react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { IntlProvider } from 'use-intl';
import { expect, it, vi } from 'vitest';
import messages from '../../../../packages/react/src/messages/en.json' with { type: 'json' };
import { DockRunControls } from './DockRunControls.tsx';

const fixture = vi.hoisted(() => ({ services: {} }));
vi.mock('../services.tsx', () => ({ useServices: () => fixture.services }));

it('[TC-WBD-006-N] controls outside hidden panes retain and open the active run, not the historical selection', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const session = createRunSession({} as RuntimeTransport);
  const projection = { ...emptyProjection('active-run'), status: 'running' as const };
  const open = vi.fn(async () => {});
  session.setState({ runId: 'active-run', projection, open });
  const release = vi.fn();
  const runFor = vi.fn(() => session);
  const retainRun = vi.fn(() => release);
  fixture.services = { runFor, retainRun };
  const onOpen = vi.fn();
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => {
      root.render(
        <IntlProvider locale="en" messages={messages} timeZone="UTC">
          <DockRunControls runId="active-run" onOpen={onOpen} />
        </IntlProvider>,
      );
    });
    expect(runFor).toHaveBeenCalledWith('active-run');
    expect(retainRun).toHaveBeenCalledWith('active-run');
    expect(open).toHaveBeenCalledWith('active-run');
    expect(container.textContent).toContain(messages.Reins.cancelRun);
    const button = container.querySelector('[data-testid="dock-open-active-run"]');
    expect(button).not.toBeNull();
    await act(async () => (button as HTMLButtonElement).click());
    expect(onOpen).toHaveBeenCalledWith('active-run');
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
  expect(release).toHaveBeenCalledOnce();
});
