// @vitest-environment jsdom
import type { AgentRole } from '@corral/contracts';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { IntlProvider } from 'use-intl';
import { afterEach, expect, it, vi } from 'vitest';
import messages from '../../../../packages/react/src/messages/en.json' with { type: 'json' };
import { HarnessRoleSettings } from './HarnessRoleSettings.tsx';

const services = vi.hoisted(() => ({ harnesses: { profileManagement: async () => [] } }));
vi.mock('../services.tsx', () => ({ useServices: () => services }));
vi.mock('@corral/react', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@corral/react')>()),
  useStudioStores: () => ({ editor: { getState: () => ({ updateNode() {} }) } }),
}));
vi.mock('./navigation.ts', () => ({
  useSettingsNavigation: () => ({ link: () => ({ to: '/' }) }),
}));
vi.mock('../pages/HarnessSettingsPage.tsx', () => ({ HarnessPreviewView: () => null }));
vi.mock('@tanstack/react-router', () => ({
  Link: ({ children }: { children?: unknown }) => <a href="/">{children as string}</a>,
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
  expect(hint.dataset.termHint).toBe('workStyle');
  expect(hint.getAttribute('aria-label')).toBe(
    messages.Terms.about.replace('{term}', messages.Terms.workStyle.name),
  );
  expect(document.getElementById(hint.getAttribute('aria-describedby') ?? '')?.textContent).toBe(
    messages.Terms.workStyle.meaning,
  );
  // Right after the label's words, inside the label's line, not in the selector.
  const label = hint.previousElementSibling;
  expect(label?.textContent).toBe(messages.Harness.heading);
  expect(hint.closest('button[role="combobox"], [data-slot="select-trigger"]')).toBeNull();
});
