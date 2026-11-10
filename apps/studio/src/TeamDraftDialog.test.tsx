// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { IntlProvider } from 'use-intl';
import { afterEach, expect, it, vi } from 'vitest';
import messages from '../../../packages/react/src/messages/en.json' with { type: 'json' };
import { TeamDraftDialog } from './TeamDraftDialog.tsx';

// The local suggestion says on its own button that it calls no model, instead of a sentence
// under it explaining what the button does.

const save = vi.hoisted(() => vi.fn());
vi.mock('./services.tsx', () => ({
  useServices: () => ({ repository: { save }, models: undefined, live: false }),
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

it('the suggestion leaves the final approval off, and the person can turn it on', async () => {
  save.mockResolvedValue({ ok: true, record: { corralId: 'team_drafted' } });
  const container = await render();
  const goal = container.querySelector('textarea');
  if (!goal) throw new Error('Expected the goal field');
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(
      goal,
      'Compare SQLite and PostgreSQL for an internal tool',
    );
    goal.dispatchEvent(new Event('input', { bubbles: true }));
  });
  const button = (label: string) =>
    [...container.querySelectorAll('button')].find((b) => b.textContent?.startsWith(label));
  await act(async () => button(messages.TeamDraft.suggest)?.click());
  const approval = [...container.querySelectorAll('[role="switch"]')].find(
    (control) =>
      control.getAttribute('aria-labelledby') &&
      document.getElementById(control.getAttribute('aria-labelledby') ?? '')?.textContent ===
        messages.TeamDraft.approval,
  );
  expect(approval?.getAttribute('aria-checked')).toBe('false');
  await act(async () => (approval as HTMLElement | undefined)?.click());
  expect(approval?.getAttribute('aria-checked')).toBe('true');
  await act(async () => button(messages.TeamDraft.open)?.click());
  const saved = save.mock.calls[0]?.[0] as {
    definition: { nodes: { type: string; requireApproval?: boolean }[] };
  };
  expect(saved.definition.nodes.find((node) => node.type === 'output')?.requireApproval).toBe(true);
});
