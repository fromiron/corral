// @vitest-environment jsdom
import type { VerificationResultView } from '@corral/client';
import type { TextAttachment } from '@corral/contracts';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { type AttachmentCapture, appendComposerAttachment } from '../workbench/context/bridge.ts';
import { readComposerDraft } from '../workbench/sessionDraft.ts';
import { Checks } from './ReviewPage.tsx';

const fixture = vi.hoisted(() => ({ services: {} }));
vi.mock('../services.tsx', () => ({ useServices: () => fixture.services }));
vi.mock('../router.tsx', () => ({ reviewRoute: {} }));
vi.mock('@tanstack/react-router', () => ({ Link: () => null, useNavigate: () => () => {} }));
vi.mock('use-intl', () => ({
  useTranslations: (namespace: string) => (key: string, values?: Record<string, unknown>) =>
    values ? `${namespace}.${key}:${JSON.stringify(values)}` : `${namespace}.${key}`,
}));
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  window.localStorage.clear();
  vi.unstubAllGlobals();
});

const tree = 'a'.repeat(40);
function check(
  state: VerificationResultView['state'],
  overrides: Partial<VerificationResultView> = {},
): VerificationResultView {
  return {
    verificationId: `verification_${state}`,
    commandId: `check_${state}`,
    name: state === 'failed' ? 'Unit tests' : 'Lint',
    argv: state === 'failed' ? ['pnpm', 'test'] : ['pnpm', 'lint'],
    tree,
    state,
    exitCode: state === 'failed' ? 2 : 0,
    signal: null,
    timedOut: false,
    durationMs: 1500,
    output:
      state === 'failed'
        ? [...Array.from({ length: 60 }, (_, i) => `ok ${i + 1}`), 'not ok 61 - adds'].join('\n')
        : 'clean',
    startedAt: '2026-11-10T01:02:00.000Z',
    endedAt: '2026-11-10T01:02:01.500Z',
    stale: false,
    ...overrides,
  };
}

async function mount(results: VerificationResultView[]) {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const sends = {
    startAuto: vi.fn(),
    startRun: vi.fn(),
    sendCommand: vi.fn(),
    verify: vi.fn(),
    cancelVerification: vi.fn(),
    recordFeedback: vi.fn(),
    addSessionEntry: vi.fn(),
  };
  fixture.services = {
    mode: 'server',
    workspaceId: 'host',
    startAuto: sends.startAuto,
    transport: { startRun: sends.startRun, sendCommand: sends.sendCommand },
    repository: { addSessionEntry: sends.addSessionEntry },
    workspaces: {
      verifications: vi.fn(async () => results),
      verify: sends.verify,
      cancelVerification: sends.cancelVerification,
      recordFeedback: sends.recordFeedback,
    },
  };
  const attached = vi.fn((attachment: TextAttachment, capture: AttachmentCapture) => {
    const result = appendComposerAttachment(capture, attachment);
    if (!result.ok) throw new Error(result.reason);
  });
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  cleanups.push(async () => {
    await act(async () => root.unmount());
    container.remove();
  });
  await act(async () =>
    root.render(
      <Checks
        sessionId="session_fix"
        projectId="project"
        binding={null}
        changed={0}
        onAttach={attached}
      />,
    ),
  );
  const rows = () => [...container.querySelectorAll<HTMLElement>('[data-testid="check-result"]')];
  const button = (row: HTMLElement, label: string) =>
    [...row.querySelectorAll('button')].find((item) => item.textContent === label);
  return { container, rows, button, attached, sends };
}

it('drafts a fix request into the composer from a failed check and sends nothing', async () => {
  const view = await mount([check('failed'), check('passed')]);
  const [failed, passed] = view.rows();
  if (!failed || !passed) throw new Error('Missing check rows');
  expect(view.button(passed, 'Checks.draftFix')).toBeUndefined();
  const draft = view.button(failed, 'Checks.draftFix');
  expect(draft).toBeDefined();
  await act(async () => draft?.click());

  expect(view.attached).toHaveBeenCalledTimes(1);
  const attachments = readComposerDraft('session_fix').attachments ?? [];
  expect(attachments).toHaveLength(1);
  const [request] = attachments;
  expect(request?.text).toContain('"Unit tests"');
  expect(request?.text).toContain('pnpm test');
  expect(request?.text).toContain('not ok 61 - adds');
  // A summary: the last lines, not the whole output.
  expect(request?.text).not.toContain('ok 1\n');
  // Written from the check, not captured from it: with no source to compare, the composer never
  // calls it changed or offers to replace it with the raw output.
  expect(request?.provenance).toBeUndefined();
  expect(readComposerDraft('session_fix').text).toBe('');
  for (const send of Object.values(view.sends)) expect(send).not.toHaveBeenCalled();
});

it('shows each record with its command, result, exit code, time, duration and validity', async () => {
  const view = await mount([
    check('failed'),
    check('passed', { stale: true, verificationId: 'verification_old' }),
  ]);
  const [current, outdated] = view.rows();
  expect(current?.textContent).toContain('pnpm test');
  expect(current?.textContent).toContain('Files.checkState.failed');
  expect(current?.textContent).toContain('Files.checkMeta:{"code":2,"ms":1500}');
  expect(current?.querySelector('time')?.getAttribute('dateTime')).toBe('2026-11-10T01:02:00.000Z');
  expect(current?.textContent).toContain('Checks.current');
  expect(current?.textContent).not.toContain('Files.stale');
  expect(outdated?.textContent).toContain('Files.stale');
  expect(outdated?.textContent).not.toContain('Checks.current');
  const output = current?.querySelector('details');
  expect(output?.querySelector('summary')?.textContent).toBe('Checks.output');
  expect(output?.textContent).toContain('not ok 61 - adds');
});
