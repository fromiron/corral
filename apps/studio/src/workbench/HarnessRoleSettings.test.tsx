// @vitest-environment jsdom
import type { AgentRole } from '@corral/contracts';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { IntlProvider } from 'use-intl';
import { afterEach, expect, it, vi } from 'vitest';
import messages from '../../../../packages/react/src/messages/en.json' with { type: 'json' };
import { HarnessRoleSettings } from './HarnessRoleSettings.tsx';

const services = vi.hoisted(() => ({
  harnesses: { profileManagement: async () => [], preview: vi.fn() },
}));
vi.mock('../services.tsx', () => ({ useServices: () => services }));
vi.mock('@corral/react', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@corral/react')>()),
  useStudioStores: () => ({ editor: { getState: () => ({ updateNode() {} }) } }),
}));
vi.mock('./navigation.ts', () => ({
  useSettingsNavigation: () => ({ link: () => ({ to: '/' }) }),
}));
vi.mock('../pages/harness/HarnessSettingsPage.tsx', () => ({ HarnessPreviewView: () => null }));
vi.mock('@tanstack/react-router', () => ({
  Link: ({ children, 'aria-label': label }: { children?: unknown; 'aria-label'?: string }) => (
    <a href="/" aria-label={label}>
      {children as string}
    </a>
  ),
}));

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  vi.unstubAllGlobals();
});

// glossary.md, "설명이 붙는 용어": the Inspector's work-style label is where the term explains
// itself in the editor, by an icon right after the label.
it('puts the work style icon right after the Inspector label', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  cleanups.push(() => {
    act(() => root.unmount());
    container.remove();
  });
  await act(async () => {
    root.render(
      <IntlProvider locale="en" messages={messages} timeZone="UTC">
        <HarnessRoleSettings role={{ id: 'writer' } as AgentRole} nodeId="n1" projectId="p1" />
      </IntlProvider>,
    );
  });
  const hints = container.querySelectorAll<HTMLElement>('[data-term-hint]');
  expect(hints).toHaveLength(1);
  const hint = hints[0] as HTMLElement;
  expect(hint.dataset.termHint).toBe('harness');
  expect(hint.getAttribute('aria-label')).toBe(
    messages.Terms.about.replace('{term}', messages.Terms.harness.name),
  );
  expect(document.getElementById(hint.getAttribute('aria-describedby') ?? '')?.textContent).toBe(
    messages.Terms.harness.meaning,
  );
  // Right after the label's words, inside the label's line, not in the selector.
  const label = hint.previousElementSibling;
  expect(label?.textContent).toBe(messages.Harness.heading);
  expect(hint.closest('button[role="combobox"], [data-slot="select-trigger"]')).toBeNull();
  // Under the field already named Harness, its link says only what it does; its accessible name
  // keeps the whole "Manage Harnesses". The name is on screen once, in the label.
  const link = container.querySelector('a');
  expect(link?.textContent).toBe(messages.Harness.manageShort);
  expect(link?.getAttribute('aria-label')).toBe(messages.Harness.manage);
  expect(messages.Harness.manageShort).not.toContain(messages.Terms.harness.name);
});

it('previews skills without a bound profile and clears an outdated problem after a selection change', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const container = document.createElement('div');
  const root = createRoot(container);
  cleanups.push(() => act(() => root.unmount()));
  const skills = [{ resourceHash: 'a'.repeat(64), entry: 'skills/writing/SKILL.md' }];
  const role = { id: 'writer', skills } as AgentRole;
  const render = async (next: AgentRole) =>
    act(async () => {
      root.render(
        <IntlProvider locale="en" messages={messages} timeZone="UTC">
          <HarnessRoleSettings role={next} nodeId="n1" projectId="p1" />
        </IntlProvider>,
      );
    });
  await render(role);
  const button = [...container.querySelectorAll('button')].find(
    (button) => button.textContent === messages.Harness.preview,
  );
  expect(button).toBeDefined();
  services.harnesses.preview.mockResolvedValueOnce({
    snapshot: null,
    problem: { roleId: role.id, reason: 'execution_policy_required', entries: [] },
  });
  await act(async () => button!.click());
  expect(services.harnesses.preview).toHaveBeenCalledWith(role, 'p1');
  expect(container.querySelector('[role=alert]')?.textContent).toBe(
    messages.Harness.roleNeedsPolicy,
  );
  await render({ ...role, skills: [] });
  expect(container.querySelector('[role=alert]')).toBeNull();
});
