// @vitest-environment jsdom
import { emptyProjection, type RunProjection } from '@corral/core';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { IntlProvider } from 'use-intl';
import { afterEach, expect, it, vi } from 'vitest';
import messages from '../../../../packages/react/src/messages/en.json' with { type: 'json' };
import { sessionStore } from '../../../../packages/react/src/stories/fixtures.tsx';
import { RunResultVersions } from './RunResultVersions.tsx';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const dispose of cleanup.splice(0)) await dispose();
  vi.unstubAllGlobals();
});

async function render(status: RunProjection['status']) {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const projection = { ...emptyProjection('run_1'), status };
  const session = sessionStore({ runId: 'run_1', projection });
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  cleanup.push(async () => {
    await act(async () => root.unmount());
    container.remove();
  });
  await act(async () =>
    root.render(
      <IntlProvider locale="en" messages={messages} timeZone="UTC">
        <RunResultVersions session={session} onOpenResult={vi.fn()} onOpenArtifact={vi.fn()} />
      </IntlProvider>,
    ),
  );
  return container;
}

// The run page's header already states that the run is still working, so the Results view adds
// no sentence about results appearing later.
it.each(['running', 'awaiting_user', 'paused'] as const)(
  'says nothing while a %s run has no results yet',
  async (status) => {
    const container = await render(status);
    expect(container.textContent).toBe('');
    expect(container.querySelector('[role="status"]')).toBeNull();
  },
);

it('says that an ended run made no results', async () => {
  const container = await render('cancelled');
  expect(container.querySelector('[role="status"]')?.textContent).toBe(messages.Results.kind.none);
});
