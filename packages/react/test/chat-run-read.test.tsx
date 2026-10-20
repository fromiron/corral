import { emptyProjection } from '@corral/core';
import { linearCorral } from '@corral/testkit';
import { act, render, screen, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { createRunSessions } from '../../../apps/studio/src/runSessions.ts';
import type { StudioServices } from '../../../apps/studio/src/services.tsx';
import { useCorralRun } from '../../../apps/studio/src/workbench/useCorralChat.ts';

let services: Pick<StudioServices, 'runFor' | 'retainRun' | 'transport' | 'readHistory'>;
vi.mock('../../../apps/studio/src/services.tsx', () => ({
  useServices: () => services,
}));

function ReadState({ runId, live = false }: { runId: string; live?: boolean }) {
  const { state } = useCorralRun(runId, live, false);
  return <p>{state.streamError ?? state.projection?.runId ?? 'Loading'}</p>;
}

it('[TC-WIDGET-001-N] a failed archived read is shown for that run instead of an endless loading state', async () => {
  const transport = {
    getSnapshot: vi.fn(async () => {
      throw new Error('Saved run temporarily unavailable');
    }),
    getRunDefinition: vi.fn(async () => linearCorral(['writer'])),
  } as unknown as StudioServices['transport'];
  services = {
    transport,
    ...createRunSessions(transport),
    readHistory: vi.fn(),
  };
  render(<ReadState runId="run_saved" />);
  await expect(screen.findByText('Saved run temporarily unavailable')).resolves.toBeVisible();
});

it('[TC-WIDGET-001-N] a live open failure is shown only for its requested target', async () => {
  const transport = {
    getRunDefinition: vi.fn(async () => {
      throw new Error('Live run unavailable');
    }),
  } as unknown as StudioServices['transport'];
  services = {
    transport,
    ...createRunSessions(transport),
    readHistory: vi.fn(),
  };
  render(<ReadState runId="run_live" live />);
  await act(() => services.runFor('run_live').getState().open('run_live'));
  expect(screen.getByText('Error: Live run unavailable')).toBeVisible();
});

it('[TC-WIDGET-001-N] a late archived error never replaces a newer run', async () => {
  let rejectOld!: (error: Error) => void;
  const transport = {
    getSnapshot: vi.fn((runId: string) =>
      runId === 'run_old'
        ? new Promise((_resolve, reject) => {
            rejectOld = reject;
          })
        : Promise.resolve({ projection: emptyProjection(runId), seq: 0 }),
    ),
    getRunDefinition: vi.fn(async () => linearCorral(['writer'])),
  } as unknown as StudioServices['transport'];
  services = {
    transport,
    ...createRunSessions(transport),
    readHistory: vi.fn(),
  };
  const view = render(<ReadState runId="run_old" />);
  await waitFor(() => expect(transport.getSnapshot).toHaveBeenCalledWith('run_old'));
  view.rerender(<ReadState runId="run_current" />);
  await screen.findByText('run_current');
  await act(async () => rejectOld(new Error('Obsolete read failed')));
  expect(screen.queryByText('Obsolete read failed')).toBeNull();
  expect(screen.getByText('run_current')).toBeVisible();
});
