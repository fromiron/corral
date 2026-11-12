// @vitest-environment jsdom
import type { MeetingView } from '@corral/contracts';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';

vi.mock('use-intl', () => ({
  useTranslations: () => (key: string, values?: { name?: string }) =>
    values?.name ? `${key}:${values.name}` : key,
}));
vi.mock('./useModels.ts', () => ({
  useModelProfiles: () => [
    { profileId: 'model-a', label: 'OpenAI · Test A' },
    { profileId: 'model-b', label: 'OpenAI · Test B' },
  ],
}));
vi.mock('@corral/react/design-kit', () => ({
  fontWeights: { normal: '', semibold: '', bold: '' },
  AgentAvatar: () => null,
  AgentStatusLabel: ({ label }: { label: string }) => <span>{label}</span>,
  Button: ({ children, variant: _v, size: _s, ...props }: any) => (
    <button {...props}>{children}</button>
  ),
  Tooltip: ({ children }: any) => children,
}));

import { MeetingParticipants } from './MeetingParticipants.tsx';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: ReturnType<typeof createRoot> | undefined;
afterEach(() => {
  act(() => root?.unmount());
  document.body.replaceChildren();
});

const view = {
  config: {
    participants: [
      // Still named after its model: the name and the model would read the same.
      { participantId: 'p1', name: 'OpenAI · Test A', modelProfile: 'model-a' },
      { participantId: 'p2', name: 'Reviewer', modelProfile: 'model-b' },
    ],
    secretary: { modelProfile: 'model-a' },
  },
  rounds: [],
} as unknown as MeetingView;

it('shows a short role beside the name while answering and while idle', () => {
  const host = document.body.appendChild(document.createElement('div'));
  root = createRoot(host);
  const withRole = {
    ...view,
    config: {
      ...view.config,
      participants: [
        { ...view.config.participants[0], role: '설계' },
        { ...view.config.participants[1], role: '검토' },
      ],
    },
    rounds: [
      {
        participantIds: ['p1'],
        answers: [{ participantId: 'p1', status: 'running', order: 1 }],
      },
    ],
  } as unknown as MeetingView;
  act(() => root?.render(<MeetingParticipants view={withRole} onMention={() => {}} />));
  const [first, second] = [...host.querySelectorAll('li')].map((item) => item.textContent);
  expect(first).toContain('설계');
  expect(first).toContain('status.running');
  expect(first?.match(/OpenAI · Test A/g)).toHaveLength(1);
  expect(second).toContain('Reviewer');
  expect(second).toContain('검토');
  expect(second).toContain('OpenAI · Test B');
  const secretary = host.querySelector('[data-participant="secretary"]')?.textContent ?? '';
  expect(secretary).not.toContain('설계');
  expect(secretary).not.toContain('검토');
});

it('shows a participant named after its model once, and a renamed one with its model', () => {
  const host = document.body.appendChild(document.createElement('div'));
  root = createRoot(host);
  act(() => root?.render(<MeetingParticipants view={view} onMention={() => {}} />));
  const [first, second] = [...host.querySelectorAll('li')].map((item) => item.textContent);
  expect(first?.match(/OpenAI · Test A/g)).toHaveLength(1);
  expect(second).toContain('Reviewer');
  expect(second).toContain('OpenAI · Test B');
});
