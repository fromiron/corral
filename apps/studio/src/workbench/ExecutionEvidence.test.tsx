// @vitest-environment jsdom
import { emptyProjection } from '@corral/core';
import { createRunSession } from '@corral/react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { ExecutionEvidence } from './ExecutionEvidence.tsx';

const fixture = vi.hoisted(() => ({ services: {} as Record<string, unknown> }));
vi.mock('../services.tsx', () => ({ useServices: () => fixture.services }));
vi.mock('@tanstack/react-router', () => ({
  Link: (props: { children: unknown; search?: unknown; to: string }) => (
    <a href={props.to} data-search={JSON.stringify(props.search ?? null)}>
      {props.children as never}
    </a>
  ),
}));
vi.mock('use-intl', () => ({
  useTranslations: () => (key: string, values?: Record<string, unknown>) =>
    values ? `${key}:${JSON.stringify(values)}` : key,
}));
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  vi.unstubAllGlobals();
});

const artifact = (id: string, executionId: string) => ({
  artifactVersionId: id,
  artifactId: `a_${id}`,
  version: 1,
  parentVersionId: null,
  name: `Result ${id}`,
  contract: 'text',
  contentHash: 'h',
  byteLength: 1,
  authorExecutionId: executionId,
  modelCallId: null,
  contextSnapshotId: null,
  submitted: true,
  configRevision: 1,
  criteriaVersionId: null,
  inputArtifactVersionIds: [],
});
const check = (id: string, runId: string, executionId: string) => ({
  verificationId: id,
  commandId: 'test',
  name: `Check ${id}`,
  state: 'failed',
  tree: 'a'.repeat(40),
  stale: false,
  output: '',
  report: {
    owner: { kind: 'execution', runId, executionId, attemptNo: 1, effectId: 'e' },
    verdict: 'fail',
  },
});

async function mount(executionId: string, files: (sessionId?: unknown) => Promise<unknown>) {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const session = createRunSession({} as never);
  session.setState({
    runId: 'run_1',
    projection: {
      ...emptyProjection('run_1'),
      artifacts: {
        v1: artifact('v1', 'exec_a'),
        v2: artifact('v2', 'exec_b'),
      } as never,
    },
  });
  fixture.services = {
    mode: 'server',
    workspaces: {
      fileOperations: vi.fn(files),
      verifications: vi.fn(async () => [
        check('check_a', 'run_1', 'exec_a'),
        check('check_other_run', 'run_0', 'exec_a'),
        check('check_b', 'run_1', 'exec_b'),
      ]),
    },
  };
  const onOpenArtifact = vi.fn();
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  cleanups.push(async () => {
    await act(async () => root.unmount());
    container.remove();
  });
  const render = (id: string, sessionId = 'session_1') =>
    act(async () =>
      root.render(
        <ExecutionEvidence
          session={session}
          sessionId={sessionId}
          executionId={id}
          onOpenArtifact={onOpenArtifact}
        />,
      ),
    );
  await render(executionId);
  return { container, onOpenArtifact, render };
}

const ops = [
  {
    id: 'op1',
    run_id: 'run_1',
    execution_id: 'exec_a',
    kind: 'write',
    path: 'src/a.ts',
    to_path: null,
    state: 'applied',
    detail: null,
    created_at: 'x',
  },
  {
    id: 'op2',
    run_id: 'run_1',
    execution_id: 'exec_a',
    kind: 'write',
    path: 'src/lost.ts',
    to_path: null,
    state: 'uncertain',
    detail: null,
    created_at: 'x',
  },
  {
    id: 'op3',
    run_id: 'run_1',
    execution_id: 'exec_b',
    kind: 'write',
    path: 'src/b.ts',
    to_path: null,
    state: 'applied',
    detail: null,
    created_at: 'x',
  },
  {
    id: 'op4',
    run_id: 'run_0',
    execution_id: 'exec_a',
    kind: 'write',
    path: 'src/old.ts',
    to_path: null,
    state: 'applied',
    detail: null,
    created_at: 'x',
  },
];

it('an execution leads to the files it wrote, its results and its checks', async () => {
  const view = await mount('exec_a', async () => ops);
  const text = view.container.textContent ?? '';
  expect(text).toContain('src/a.ts');
  expect(text).toContain('src/lost.ts');
  expect(text).not.toContain('src/b.ts');
  expect(text).not.toContain('src/old.ts');
  expect(text).toContain('Check check_a');
  expect(text).not.toContain('check_other_run');
  expect(text).not.toContain('check_b');
  const file = [...view.container.querySelectorAll('a')].find((a) =>
    a.textContent?.includes('src/a.ts'),
  );
  expect(file?.getAttribute('href')).toBe('/sessions/$sessionId/review');
  expect(JSON.parse(file?.getAttribute('data-search') ?? 'null')).toEqual({
    scope: 'run',
    runId: 'run_1',
    file: 'src/a.ts',
  });
  // An uncertain write is shown as such, not as the execution's change.
  const lost = [...view.container.querySelectorAll('li')].find((li) =>
    li.textContent?.includes('src/lost.ts'),
  );
  expect(lost?.textContent).toContain('uncertain');
  const result = [...view.container.querySelectorAll('button')].find((b) =>
    b.textContent?.includes('Result v1'),
  );
  await act(async () => result?.click());
  expect(view.onOpenArtifact).toHaveBeenCalledWith('v1');
  expect(text).not.toContain('Result v2');
});

it('a late answer for the session left behind is not shown for the next one', async () => {
  let release = (_value: unknown) => {};
  const slow = new Promise((done) => {
    release = done;
  });
  const view = await mount('exec_a', (sessionId?: unknown) =>
    sessionId === 'session_1' ? slow : Promise.resolve([]),
  );
  await view.render('exec_a', 'session_2');
  await act(async () => release(ops));
  expect(view.container.textContent ?? '').not.toContain('src/a.ts');
});
