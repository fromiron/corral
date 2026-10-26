// @vitest-environment jsdom
import { Identifier, type MeetingView } from '@corral/contracts';
import type { WorkSession } from '@corral/core';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({ services: {} as any }));
vi.mock('../services.tsx', () => ({ useServices: () => fixture.services }));
vi.mock('use-intl', () => ({ useTranslations: () => (key: string) => key }));
vi.mock('./MeetingHandoff.tsx', () => ({ MeetingHandoff: () => <p>handoff-action</p> }));
vi.mock('@corral/react/design-kit', () => ({
  Input: (props: any) => <input {...props} />,
  Textarea: (props: any) => <textarea {...props} />,
  Button: ({ children, variant: _v, size: _s, ...props }: any) => (
    <button {...props}>{children}</button>
  ),
  Select: ({ label, value, options, onValueChange, ...props }: any) => (
    <select
      aria-label={label}
      value={value}
      onChange={(e) => onValueChange(e.target.value)}
      {...props}
    >
      {options.map((o: any) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  ),
}));
const { MeetingDecisions } = await import('./MeetingDecisions.tsx');
const content = {
  goal: 'Ship safely',
  scope: ['web'],
  excludedScope: ['mobile'],
  acceptanceCriteria: ['tests pass'],
  remainingDissent: ['rollout timing'],
  evidence: ['round_1'],
  risks: ['migration'],
  actions: ['build', 'verify'],
  rejectedAlternatives: ['rewrite'],
};
const decision = {
  versionId: 'v1',
  commandId: 'adopt1',
  minutesId: 'm1',
  candidateId: 'c1',
  supersedesVersionId: null,
  content,
  createdAt: 'now',
};
const view = {
  sessionId: 'meeting',
  revision: 1,
  config: {
    version: 1,
    participants: [
      { participantId: 'p1', name: 'Architect' },
      { participantId: 'p2', name: 'Tester' },
    ],
    secretary: { modelProfile: 'a' },
  },
  rounds: [
    {
      roundId: 'round_1',
      participantIds: ['p1', 'p2'],
      answers: [
        { participantId: 'p1', status: 'answered' },
        { participantId: 'p2', status: 'failed', detail: 'offline' },
      ],
    },
  ],
  minutes: [
    {
      minutesId: 'm1',
      roundId: 'round_1',
      createdAt: 'now',
      error: null,
      document: {
        issues: ['release'],
        claims: [{ roundId: 'round_1', participantId: 'p1', text: 'Ship' }],
        agreements: [],
        remainingDissent: [{ roundId: 'round_1', participantId: 'p1', text: 'rollout timing' }],
        unverifiedFacts: ['migration size'],
        candidates: [{ candidateId: 'c1', content }],
      },
    },
  ],
  decisions: [],
  decisionWithdrawals: [],
} as unknown as MeetingView;
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const f of cleanup.splice(0)) await f();
  vi.restoreAllMocks();
});
async function mount(current = view) {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.spyOn(crypto, 'randomUUID').mockReturnValue('00000000-0000-4000-8000-000000000000');
  const adopt = vi.fn(async (_sessionId: string, _request: { commandId: string }) => ({
    ok: true,
    decision,
  }));
  const withdraw = vi.fn(async (_sessionId: string, _request: { commandId: string }) => ({
    ok: true,
  }));
  fixture.services = { meetings: { adopt, withdraw } };
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const onChange = vi.fn(async () => {});
  await act(async () =>
    root.render(
      <MeetingDecisions
        session={{ sessionId: 'meeting', projectId: 'project' } as WorkSession}
        view={current}
        onChange={onChange}
      />,
    ),
  );
  cleanup.push(async () => {
    await act(async () => root.unmount());
    container.remove();
  });
  const button = (text: string) =>
    [...container.querySelectorAll('button')].find((b) => b.textContent === text)!;
  return { container, adopt, withdraw, button, onChange };
}
it('shows dissent and failed participants, and adopts only the edited human selection', async () => {
  const f = await mount();
  expect(f.container.textContent).toContain('rollout timing');
  expect(f.container.textContent).toContain('Tester');
  expect(f.container.textContent).toContain('nonresponse');
  expect(f.container.textContent).not.toContain('handoff-action');
  await act(async () => f.button('editCandidate').click());
  const actions = f.container.querySelector('textarea[name="actions"]')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(
      actions,
      'verify',
    );
    actions.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await act(async () => f.button('adopt').click());
  expect(Identifier.safeParse(f.adopt.mock.calls[0]?.[1].commandId).success).toBe(true);
  expect(f.adopt).toHaveBeenCalledWith(
    'meeting',
    expect.objectContaining({
      minutesId: 'm1',
      candidateId: 'c1',
      content: expect.objectContaining({
        actions: ['verify'],
        remainingDissent: ['rollout timing'],
      }),
    }),
  );
});
it('withdrawn and superseded versions cannot hand off', async () => {
  const f = await mount({
    ...view,
    decisions: [decision, { ...decision, versionId: 'v2', supersedesVersionId: 'v1' }],
    decisionWithdrawals: [
      { commandId: 'w', versionId: 'v2', reason: 'Changed mind', createdAt: 'now' },
    ],
  } as MeetingView);
  expect(f.container.textContent).toContain('superseded');
  expect(f.container.textContent).toContain('withdrawn');
  expect(f.container.textContent).not.toContain('handoff-action');
});
it('a lost adoption response reuses the command ID', async () => {
  const f = await mount();
  f.adopt.mockRejectedValueOnce(new Error('offline'));
  await act(async () => f.button('editCandidate').click());
  await act(async () => f.button('adopt').click());
  expect(f.container.querySelector('[role="alert"]')?.textContent).toContain('offline');
  await act(async () => f.button('adopt').click());
  expect(f.adopt.mock.calls[0]?.[1].commandId).toBe(f.adopt.mock.calls[1]?.[1].commandId);
});

it('revisions name the replaced version and withdrawal requires a human reason', async () => {
  const f = await mount({ ...view, decisions: [decision] } as MeetingView);
  await act(async () => f.button('revise').click());
  await act(async () => f.button('adopt').click());
  expect(f.adopt).toHaveBeenCalledWith(
    'meeting',
    expect.objectContaining({ supersedesVersionId: 'v1' }),
  );
  await act(async () => f.button('withdraw').click());
  expect(f.button('confirmWithdraw').disabled).toBe(true);
  const reason = f.container.querySelector('textarea') as HTMLTextAreaElement;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(
      reason,
      'Scope changed',
    );
    reason.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await act(async () => f.button('confirmWithdraw').click());
  expect(f.withdraw).toHaveBeenCalledWith(
    'meeting',
    expect.objectContaining({ versionId: 'v1', reason: 'Scope changed' }),
  );
  expect(Identifier.safeParse(f.withdraw.mock.calls[0]?.[1].commandId).success).toBe(true);
});
