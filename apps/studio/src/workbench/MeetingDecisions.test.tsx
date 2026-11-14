// @vitest-environment jsdom
import { Identifier, type MeetingView } from '@corral/contracts';
import type { WorkSession } from '@corral/core';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({ services: {} as any }));
vi.mock('../services.tsx', () => ({ useServices: () => fixture.services }));
vi.mock('use-intl', () => ({
  useTranslations: () => (key: string, values?: { number?: number; goal?: string }) =>
    `${key}${values?.number ?? ''}${values?.goal ?? ''}`,
  useFormatter: () => ({ dateTime: () => 'local-date' }),
}));
vi.mock('./MeetingHandoff.tsx', () => ({ MeetingHandoff: () => <p>handoff-action</p> }));
vi.mock('@corral/react/design-kit', () => ({
  fontWeights: { normal: '', semibold: '', bold: '' },
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
const { MeetingDecisions, meetingDecisionEdits } = await import('./MeetingDecisions.tsx');
// jsdom does not scroll; a form that opens asks to be brought into view.
Element.prototype.scrollIntoView ??= () => {};
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
  meetingDecisionEdits.setState({}, true);
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
it('opening a candidate for adoption brings its form into view, focused on the goal', async () => {
  const reveal = vi.spyOn(Element.prototype, 'scrollIntoView');
  const f = await mount();
  const open = f.button('editCandidate');
  open.focus();
  await act(async () => open.click());
  expect(document.activeElement).toBe(f.container.querySelector('textarea[name="goal"]'));
  expect(reveal).toHaveBeenCalled();
  // Cancelling returns focus to the button that opened the form.
  await act(async () => f.button('cancel').click());
  expect(f.container.querySelector('textarea[name="goal"]')).toBeNull();
  expect(document.activeElement).toBe(open);
});

it('a revision form opens in view and focused, and a draft restored on remount takes no focus', async () => {
  const reveal = vi.spyOn(Element.prototype, 'scrollIntoView');
  const decided = { ...view, decisions: [decision] } as MeetingView;
  const first = await mount(decided);
  await act(async () => first.button('revise').click());
  expect(document.activeElement).toBe(first.container.querySelector('textarea[name="goal"]'));
  for (const unmount of cleanup.splice(0)) await unmount();
  reveal.mockClear();
  (document.activeElement as HTMLElement | null)?.blur();
  const second = await mount(decided);
  expect(second.container.querySelector('textarea[name="goal"]')).not.toBeNull();
  expect(document.activeElement).toBe(document.body);
  expect(reveal).not.toHaveBeenCalled();
});

it('an adopted candidate reads as one line naming its decision; the decision stays open', async () => {
  const other = { candidateId: 'c2', content: { ...content, goal: 'Rewrite later' } };
  const minutes = view.minutes?.[0];
  if (!minutes?.document) throw new Error('The minutes fixture is missing');
  const f = await mount({
    ...view,
    minutes: [
      {
        ...minutes,
        document: { ...minutes.document, candidates: [{ candidateId: 'c1', content }, other] },
      },
    ],
    decisions: [decision],
  } as MeetingView);
  const adopted = f.container.querySelector<HTMLDetailsElement>('details[data-candidate="c1"]');
  expect(adopted).not.toBeNull();
  expect(adopted?.open).toBe(false);
  expect(adopted?.querySelector('summary')?.textContent).toContain('Ship safely');
  expect(adopted?.querySelector('summary')?.textContent).toContain('adoptedAs1');
  // The decision's sections are what stays open: they appear once outside the folded candidate.
  const openText = [...f.container.querySelectorAll('article')]
    .filter((item) => !item.closest('details[data-candidate]'))
    .map((item) => item.textContent ?? '')
    .join(' ');
  expect(openText).toContain('decisionLabel1Ship safely');
  // A candidate that was not adopted stays as it was, ready to edit before adopting.
  const pending = f.container.querySelector('[data-candidate="c2"]');
  expect(pending?.tagName).not.toBe('DETAILS');
  expect(pending?.textContent).toContain('Rewrite later');
  expect(
    [...(pending?.querySelectorAll('button') ?? [])].some((b) => b.textContent === 'editCandidate'),
  ).toBe(true);
  // The adopted candidate can still be opened and adopted again.
  expect(
    [...(adopted?.querySelectorAll('button') ?? [])].some((b) => b.textContent === 'editCandidate'),
  ).toBe(true);
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

it('an edited decision and its unanswered adoption survive a remount of the records', async () => {
  let issued = 0;
  const distinctIds = () =>
    vi
      .spyOn(crypto, 'randomUUID')
      .mockImplementation(
        () => `00000000-0000-4000-8000-${String(++issued).padStart(12, '0')}` as const,
      );
  const first = await mount();
  distinctIds();
  first.adopt.mockRejectedValueOnce(new Error('offline'));
  await act(async () => first.button('editCandidate').click());
  const goal = first.container.querySelector<HTMLTextAreaElement>('textarea[name="goal"]');
  if (!goal) throw new Error('The decision form is missing');
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(
      goal,
      'Ship after review',
    );
    goal.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await act(async () => first.button('adopt').click());
  // The records close (the drawer, or the panel moving across the breakpoint) and reopen.
  for (const unmount of cleanup.splice(0)) await unmount();
  const second = await mount();
  distinctIds();
  expect(second.container.querySelector<HTMLTextAreaElement>('textarea[name="goal"]')?.value).toBe(
    'Ship after review',
  );
  await act(async () => second.button('adopt').click());
  expect(second.adopt.mock.calls[0]?.[1].commandId).toBe(first.adopt.mock.calls[0]?.[1].commandId);
  expect(second.container.querySelector('textarea[name="goal"]')).toBeNull();
  // Adopted, it is gone for good.
  for (const unmount of cleanup.splice(0)) await unmount();
  const third = await mount();
  expect(third.container.querySelector('textarea[name="goal"]')).toBeNull();
});

it('a half-typed withdrawal reason survives a remount until it is withdrawn or cancelled', async () => {
  const decided = { ...view, decisions: [decision] } as MeetingView;
  const reasonBox = (container: HTMLElement) =>
    container.querySelector<HTMLTextAreaElement>('textarea:not([name])');
  const first = await mount(decided);
  await act(async () => first.button('withdraw').click());
  const reason = reasonBox(first.container);
  if (!reason) throw new Error('The withdrawal form is missing');
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(
      reason,
      'Scope chan',
    );
    reason.dispatchEvent(new Event('input', { bubbles: true }));
  });
  for (const unmount of cleanup.splice(0)) await unmount();
  const second = await mount(decided);
  expect(reasonBox(second.container)?.value).toBe('Scope chan');
  // Cancelling discards it for good.
  await act(async () => second.button('cancel').click());
  expect(reasonBox(second.container)).toBeNull();
  for (const unmount of cleanup.splice(0)) await unmount();
  const third = await mount(decided);
  expect(reasonBox(third.container)).toBeNull();
  // A confirmed withdrawal does too.
  await act(async () => third.button('withdraw').click());
  const again = reasonBox(third.container);
  if (!again) throw new Error('The withdrawal form is missing');
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(
      again,
      'Scope changed',
    );
    again.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await act(async () => third.button('confirmWithdraw').click());
  expect(third.withdraw).toHaveBeenCalledWith(
    'meeting',
    expect.objectContaining({ versionId: 'v1', reason: 'Scope changed' }),
  );
  for (const unmount of cleanup.splice(0)) await unmount();
  const fourth = await mount(decided);
  expect(reasonBox(fourth.container)).toBeNull();
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

it('labels decisions by version and goal, localizes minutes time and folds internal IDs', async () => {
  const f = await mount({ ...view, decisions: [decision] });
  expect(f.container.querySelector('time')?.textContent).toBe('local-date');
  const headings = [...f.container.querySelectorAll('h3')].map((heading) => heading.textContent);
  expect(headings).toContain('decisionLabel1Ship safely');
  expect(headings.some((heading) => heading?.includes(decision.versionId))).toBe(false);
  const ids = [...f.container.querySelectorAll('details')].find((item) =>
    item.textContent?.includes(decision.versionId),
  );
  expect(ids?.open).toBe(false);
});
it('hangs the minutes lists: a wrapped item continues under its text, not under its bullet', async () => {
  const f = await mount();
  const lists = [...f.container.querySelectorAll('ul')].filter((list) => list.querySelector('li'));
  expect(lists.length).toBeGreaterThan(0);
  for (const list of lists) {
    // The bullet sits outside the text's box, in the list's own left padding.
    expect(list.className).toMatch(/\blist-outside\b/);
    expect(list.className).toMatch(/\bpl-\d/);
    expect(list.className).not.toMatch(/\blist-inside\b/);
  }
});
