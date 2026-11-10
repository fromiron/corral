// @vitest-environment jsdom
import {
  type ArtifactVersionView,
  type ExecutionView,
  emptyProjection,
  type RunProjection,
} from '@corral/core';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { IntlProvider } from 'use-intl';
import { afterEach, expect, it, vi } from 'vitest';
import messages from '../../../../packages/react/src/messages/en.json' with { type: 'json' };
import { sessionStore } from '../../../../packages/react/src/stories/fixtures.tsx';
import { RunResultVersions } from './RunResultVersions.tsx';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const dispose of cleanup.splice(0)) await dispose();
  vi.unstubAllGlobals();
});

const execution = (executionId: string, nodeId: string) =>
  ({ executionId, nodeId, attemptNo: 1, iterationId: null }) as ExecutionView;
const artifact = (id: string, name: string, authorExecutionId: string, kept = true) =>
  ({
    artifactVersionId: id,
    artifactId: `art_${id}`,
    version: 1,
    parentVersionId: null,
    name,
    contract: 'notes',
    authorExecutionId,
    submitted: true,
    byteLength: 10,
    ...(kept ? {} : { bodyAvailable: false }),
  }) as ArtifactVersionView;

/** Two parallel helpers each made a notes-part v1 in their first attempt; one is no longer kept. */
async function render() {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const projection: RunProjection = {
    ...emptyProjection('run_1'),
    status: 'running',
    executionOrder: ['exec_r', 'exec_h1', 'exec_h2'],
    executions: {
      exec_r: execution('exec_r', 'Research'),
      exec_h1: execution('exec_h1', 'Helper'),
      exec_h2: execution('exec_h2', 'Helper'),
    },
    artifacts: {
      v_notes: artifact('v_notes', 'notes', 'exec_r'),
      v_part1: artifact('v_part1', 'notes-part', 'exec_h1'),
      v_part2: artifact('v_part2', 'notes-part', 'exec_h2', false),
    },
  };
  const session = sessionStore({ runId: 'run_1', projection });
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  cleanup.push(async () => {
    await act(async () => root.unmount());
    container.remove();
  });
  await act(async () =>
    root.render(
      <IntlProvider locale="en" messages={messages} timeZone="UTC">
        <RunResultVersions session={session} onOpenResult={vi.fn()} onOpenArtifact={vi.fn()} />
      </IntlProvider>,
    ),
  );
  return container;
}
const row = (container: HTMLElement, id: string) =>
  container.querySelector(`[data-result-version="${id}"]`) as HTMLTableRowElement;

// The row starts as the result reader names a version's author: the agent and its execution.
it('tells two same-named versions apart by the execution that made each', async () => {
  const container = await render();
  const madeBy = (id: string) => row(container, id).cells[1]?.textContent;
  expect(madeBy('v_part1')).toBe('Helper · execution 2 · Attempt 1');
  expect(madeBy('v_part2')).toBe('Helper · execution 3 · Attempt 1');
  expect(madeBy('v_notes')).toBe('Research · execution 1 · Attempt 1');
});

it('sets a name that is no longer kept as the other names are, its note as a second line', async () => {
  const container = await render();
  const button = row(container, 'v_part1').querySelector('button');
  const size = [...(button?.classList ?? [])].find((name) => name.startsWith('text-[length:'));
  expect(size).toBeDefined();
  const [name, note] = [
    ...(row(container, 'v_part2').cells[0]?.querySelectorAll('span span') ?? []),
  ];
  expect(name?.textContent).toBe('notes-part');
  expect(name?.classList.contains(size as string)).toBe(true);
  expect(note?.textContent).toBe(messages.RunMonitor.resultVersions.notKept);
});
