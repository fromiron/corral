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

it('shows a participant named after its model once, and a renamed one with its model', () => {
  const host = document.body.appendChild(document.createElement('div'));
  root = createRoot(host);
  act(() => root?.render(<MeetingParticipants view={view} onMention={() => {}} />));
  const [first, second] = [...host.querySelectorAll('li')].map((item) => item.textContent);
  expect(first?.match(/OpenAI · Test A/g)).toHaveLength(1);
  expect(second).toContain('Reviewer');
  expect(second).toContain('OpenAI · Test B');
});
