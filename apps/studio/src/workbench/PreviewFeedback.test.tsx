// @vitest-environment jsdom
import type { WorkspacePreview } from '@corral/client';
import type { ImageAttachment, PreviewObservation } from '@corral/contracts';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { IntlProvider } from 'use-intl';
import { afterEach, expect, it, vi } from 'vitest';
import messages from '../../../../packages/react/src/messages/en.json' with { type: 'json' };
import { PreviewFeedback } from './PreviewFeedback.tsx';
import {
  clearSentComposerDraft,
  composerDraftRevision,
  readComposerDraft,
  writeComposerDraft,
} from './sessionDraft.ts';

const fixture = vi.hoisted(() => ({
  services: {} as Record<string, unknown>,
  capture: vi.fn(),
  cancel: vi.fn(async () => {}),
}));
vi.mock('../services.tsx', () => ({ useServices: () => fixture.services }));
vi.mock('../desktop.tsx', () => ({
  previewDesktop: { capturePreview: fixture.capture, cancelPreviewCapture: fixture.cancel },
}));
const lease: WorkspacePreview = {
  leaseId: 'preview_one',
  sessionId: 'session',
  operationId: 'task_one',
  kind: 'service',
  url: 'http://127.0.0.2:43800/',
  origin: 'http://127.0.0.2:43800',
  path: '/',
  state: 'ready',
  createdAt: '2026-10-24T01:00:00.000Z',
};
const image: ImageAttachment = {
  kind: 'image_attachment',
  imageId: 'image_one',
  name: 'preview.png',
  mime: 'image/png',
  bytes: 68,
  sha256: 'a'.repeat(64),
  width: 1,
  height: 1,
};
const observation: PreviewObservation = {
  sessionId: 'session',
  leaseId: lease.leaseId,
  capturedAt: lease.createdAt,
  url: lease.url,
  pageRevision: 2,
  sourceRevision: null,
  element: {
    tag: 'button',
    role: 'button',
    selector: '#greeting',
    text: 'Hello preview',
    bounds: { x: 1, y: 2, width: 40, height: 30 },
    styles: { color: 'rgb(0, 0, 0)' },
  },
  console: [],
  screenshot: {
    mime: 'image/png',
    width: 1,
    height: 1,
    data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==',
  },
};
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  localStorage.clear();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});
async function mount() {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  writeComposerDraft('session', {
    text: 'my request',
    intent: null,
    target: null,
    targetLabel: null,
    references: [],
  });
  const upload = vi.fn(
    async (_session: string, _name: string, _blob: Blob, _signal?: AbortSignal) => image,
  );
  const copy = vi.fn(async () => ({
    sessionId: 'session',
    bindingId: 'binding',
    copyGeneration: 1,
    missing: false,
    removedAt: null,
  }));
  fixture.services = {
    mode: 'server',
    workspaceId: 'host',
    workspaces: {
      binding: async () => ({ bindingId: 'binding', projectId: 'project', missing: false }),
      worktree: copy,
      previews: async () => [lease],
      uploadImage: upload,
    },
  };
  fixture.capture.mockResolvedValue(observation);
  const element = document.createElement('div');
  document.body.append(element);
  const root = createRoot(element);
  await act(async () =>
    root.render(
      <IntlProvider locale="en" messages={messages} timeZone="UTC">
        <PreviewFeedback projectId="project" sessionId="session" lease={lease} />
      </IntlProvider>,
    ),
  );
  cleanups.push(async () => {
    await act(async () => root.unmount());
    element.remove();
  });
  const click = async (label: string) =>
    act(async () => {
      [...document.querySelectorAll('button')]
        .find((button) => button.textContent === label)
        ?.click();
    });
  return { upload, click, element, copy };
}
it('[TC-WBD-020-H] reviews a frozen observation before uploading and atomically attaches image and text metadata', async () => {
  const f = await mount();
  await f.click('Capture preview feedback');
  expect(fixture.capture).toHaveBeenCalledWith('session', lease.leaseId, {
    screenshot: true,
    console: false,
  });
  expect(document.body.textContent).toContain('Review preview feedback');
  expect(document.body.textContent).toContain('Hello preview');
  expect(f.upload).not.toHaveBeenCalled();
  await f.click('Attach to request');
  expect(f.upload).toHaveBeenCalledTimes(1);
  const draft = readComposerDraft('session');
  expect(draft.images).toEqual([image]);
  expect(draft.attachments?.[0]?.provenance).toMatchObject({
    kind: 'preview',
    leaseId: lease.leaseId,
    pageRevision: 2,
    sourceRevision: null,
    screenshotHash: image.sha256,
  });
  expect(JSON.stringify(draft)).not.toContain(observation.screenshot!.data);
});
it('[TC-WBD-020-F] rejects a capture after its destination draft was sent', async () => {
  const f = await mount();
  let resolve!: (value: PreviewObservation) => void;
  fixture.capture.mockImplementationOnce(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  f.copy.mockResolvedValueOnce({
    sessionId: 'other_session',
    bindingId: 'binding',
    copyGeneration: 1,
    missing: false,
    removedAt: null,
  });
  await f.click('Capture preview feedback');
  expect(fixture.capture).not.toHaveBeenCalled();
  await f.click('Capture preview feedback');
  clearSentComposerDraft('session', composerDraftRevision('session'));
  await act(async () => resolve(observation));
  expect(document.body.textContent).not.toContain('Review preview feedback');
  expect(f.upload).not.toHaveBeenCalled();
  expect(readComposerDraft('session').attachments).toBeUndefined();
});
it('[TC-WBD-020-N] cancelling review aborts a pending upload and cannot attach its late result', async () => {
  const f = await mount();
  await f.click('Capture preview feedback');
  let resolve!: (value: ImageAttachment) => void;
  f.upload.mockImplementationOnce(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  await f.click('Attach to request');
  const signal = f.upload.mock.calls[0]?.[3];
  await f.click('Cancel');
  expect(signal?.aborted).toBe(true);
  await act(async () => resolve(image));
  expect(readComposerDraft('session')).toMatchObject({ text: 'my request' });
  expect(readComposerDraft('session').attachments).toBeUndefined();
  expect(readComposerDraft('session').images).toBeUndefined();
});
