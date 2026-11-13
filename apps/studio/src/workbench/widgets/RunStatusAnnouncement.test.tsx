// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { IntlProvider } from 'use-intl';
import { afterEach, expect, it, vi } from 'vitest';
import messages from '../../../../../packages/react/src/messages/en.json' with { type: 'json' };
import { RunStatusAnnouncement } from './RunStatusAnnouncement.tsx';

const disposals: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const dispose of disposals.splice(0)) await dispose();
  vi.unstubAllGlobals();
});

async function mount() {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  disposals.push(async () => {
    await act(async () => root.unmount());
    container.remove();
  });
  const render = async (runId: string, status: string, ready = true) => {
    await act(async () => {
      root.render(
        <IntlProvider locale="en" messages={messages}>
          <RunStatusAnnouncement runId={runId} status={status} ready={ready} />
        </IntlProvider>,
      );
    });
    const region = container.querySelector('[aria-live="polite"]');
    if (!region) throw new Error('Missing run status live region');
    return region;
  };
  return render;
}

it('announces observed completion and failure without announcing opened history', async () => {
  const render = await mount();
  expect((await render('old', 'succeeded')).textContent).toBe('');
  expect((await render('current', 'running')).textContent).toBe('');
  const region = await render('current', 'succeeded');
  expect(region.textContent).toBe('Run status: Completed');
  const changes = vi.fn();
  const observer = new MutationObserver(changes);
  observer.observe(region, { childList: true, characterData: true, subtree: true });
  await render('current', 'succeeded');
  expect(changes).not.toHaveBeenCalled();
  observer.disconnect();
  expect((await render('next', 'running')).textContent).toBe('');
  expect((await render('next', 'failed')).textContent).toBe('Run status: Failed');
});

it('keeps the last known state across a reconnect and ignores unavailable projections', async () => {
  const render = await mount();
  await render('current', 'running');
  expect((await render('current', 'failed', false)).textContent).toBe('');
  expect((await render('current', 'cancelled')).textContent).toBe('Run status: Cancelled');
  expect((await render('history', 'failed', false)).textContent).toBe('');
  expect((await render('history', 'failed')).textContent).toBe('');
});

it('says the state in its presence words and keeps quiet when only the status, not its state, moved', async () => {
  const render = await mount();
  await render('current', 'created');
  // Created and validating are both "Starting" on every screen.
  expect((await render('current', 'validating')).textContent).toBe('');
  expect((await render('current', 'cancelling')).textContent).toBe('Run status: Stopping');
});
