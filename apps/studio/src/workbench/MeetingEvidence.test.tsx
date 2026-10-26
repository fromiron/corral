// @vitest-environment jsdom
import type { TextAttachment } from '@corral/contracts';
import { createTextAttachment, emptyProjection } from '@corral/core';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({ services: {} as Record<string, unknown> }));
vi.mock('../services.tsx', () => ({ useServices: () => fixture.services }));
vi.mock('use-intl', () => ({ useTranslations: () => (key: string) => key }));
vi.mock('@corral/react/design-kit', () => ({
  Button: ({ children, variant: _v, size: _s, ...props }: any) => (
    <button {...props}>{children}</button>
  ),
}));
const { MeetingEvidencePicker } = await import('./MeetingEvidence.tsx');
const body = 'Only this chosen result.';
const digest = createTextAttachment('result.txt', 'text/plain', body);
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  vi.unstubAllGlobals();
});

async function mount(read = async (): Promise<string | null> => body) {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const transport = {
    listRuns: vi.fn(async () => [
      { runId: 'chosen_run', sessionId: 'work_1', projectId: null, startedAt: 'today' },
      { runId: 'foreign_run', sessionId: 'work_other', projectId: 'other', startedAt: 'today' },
    ]),
    getSnapshot: vi.fn(async () => ({
      projection: {
        ...emptyProjection('chosen_run'),
        artifacts: {
          chosen_version: {
            artifactVersionId: 'chosen_version',
            name: 'Answer',
            version: 1,
            byteLength: digest.bytes,
            contentHash: digest.sha256,
            submitted: true,
          },
        },
      },
    })),
    getArtifactText: vi.fn(read),
  };
  fixture.services = {
    transport,
    repository: { listSessions: vi.fn(async () => [{ sessionId: 'work_1' }]) },
  };
  const onChange = vi.fn();
  const onLoading = vi.fn();
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  let mounted = true;
  const unmount = async () => {
    if (mounted) await act(async () => root.unmount());
    mounted = false;
    container.remove();
  };
  cleanups.push(unmount);
  const render = (value: TextAttachment[] = []) =>
    act(async () =>
      root.render(
        <MeetingEvidencePicker
          projectId="project"
          value={value}
          onChange={onChange}
          onLoading={onLoading}
          disabled={false}
        />,
      ),
    );
  await render();
  const click = async (prefix: string) =>
    act(async () => {
      const button = [...container.querySelectorAll('button')].find((item) =>
        item.textContent?.startsWith(prefix),
      );
      if (!button) throw new Error(`Missing button: ${prefix}`);
      button.click();
    });
  return { transport, onChange, onLoading, container, render, unmount, click };
}

it('reads no source until selected and freezes only one chosen artifact', async () => {
  const f = await mount();
  expect(f.transport.listRuns).not.toHaveBeenCalled();
  expect(f.transport.getSnapshot).not.toHaveBeenCalled();
  expect(f.transport.getArtifactText).not.toHaveBeenCalled();
  await f.click('evidenceResults');
  expect(f.container.textContent).toContain('chosen_run');
  expect(f.container.textContent).not.toContain('foreign_run');
  expect(f.transport.getSnapshot).not.toHaveBeenCalled();
  await f.click('chosen_run');
  expect(f.transport.getSnapshot).toHaveBeenCalledExactlyOnceWith('chosen_run');
  expect(f.transport.getArtifactText).not.toHaveBeenCalled();
  await f.click('Answer v1');
  expect(f.transport.getArtifactText).toHaveBeenCalledExactlyOnceWith(
    'chosen_run',
    'chosen_version',
  );
  expect(f.onChange).toHaveBeenCalledExactlyOnceWith([
    expect.objectContaining({
      text: `Run: chosen_run\nArtifact version: chosen_version\n\n${body}`,
    }),
  ]);
});

it('a missing result preserves selected evidence and exposes an error', async () => {
  const f = await mount(async () => null);
  const existing = createTextAttachment('keep.txt', 'text/plain', 'Kept.');
  await f.render([existing]);
  await f.click('evidenceResults');
  await f.click('chosen_run');
  await f.click('Answer v1');
  expect(f.onChange).not.toHaveBeenCalled();
  expect(f.container.querySelector('[role="alert"]')?.textContent).toBe('evidenceFailed');
  expect(f.container.textContent).toContain('keep.txt');
});

it('a late capture after leaving the meeting cannot change another draft', async () => {
  let finish!: (text: string) => void;
  const pending = new Promise<string>((resolve) => {
    finish = resolve;
  });
  const f = await mount(() => pending);
  await f.click('evidenceResults');
  await f.click('chosen_run');
  await f.click('Answer v1');
  await f.unmount();
  await act(async () => finish(body));
  expect(f.onChange).not.toHaveBeenCalled();
});
