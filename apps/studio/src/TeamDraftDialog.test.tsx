// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { IntlProvider } from 'use-intl';
import { afterEach, expect, it, vi } from 'vitest';
import messages from '../../../packages/react/src/messages/en.json' with { type: 'json' };
import { TeamDraftDialog } from './TeamDraftDialog.tsx';

// The local suggestion says on its own button that it calls no model, instead of a sentence
// under it explaining what the button does.

vi.mock('./services.tsx', () => ({
  useServices: () => ({ repository: { save: vi.fn() }, models: undefined, live: false }),
}));
vi.mock('@tanstack/react-router', () => ({ useNavigate: () => vi.fn() }));

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

async function render() {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  await act(async () =>
    root.render(
      <IntlProvider locale="en" messages={messages}>
        <TeamDraftDialog onClose={() => {}} />
      </IntlProvider>,
    ),
  );
  cleanups.push(() => {
    act(() => root.unmount());
    container.remove();
  });
  return container;
}

it('marks the local suggestion button as making no model call', async () => {
  const container = await render();
  const suggest = [...container.querySelectorAll('button')].find((button) =>
    button.textContent?.startsWith(messages.TeamDraft.suggest),
  );
  expect(suggest?.textContent).toContain(messages.TeamDraft.noModelCall);
});

it('puts no explaining sentence under the suggestion button', async () => {
  const container = await render();
  expect(container.textContent).not.toContain('Picks a team shape');
});
