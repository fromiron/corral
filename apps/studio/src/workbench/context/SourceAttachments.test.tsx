// @vitest-environment jsdom
import { createTextAttachment } from '@corral/core';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { SourceAttachments, SourceNavigationContext } from './SourceAttachments.tsx';

const fixture = vi.hoisted(() => ({ services: {}, read: vi.fn(), recapture: vi.fn() }));
vi.mock('../../services.tsx', () => ({ useServices: () => fixture.services }));
vi.mock('./sources.ts', () => ({
  readAttachmentSource: fixture.read,
  recaptureAttachmentSource: fixture.recapture,
}));
vi.mock('use-intl', () => ({
  useTranslations: (namespace: string) => (key: string) => `${namespace}.${key}`,
}));

it('stale sources open the unchanged read-only capture and replacement requires explicit confirmation', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const provenance = {
    kind: 'hunk' as const,
    hostId: 'host',
    projectId: 'project',
    sessionId: 'session',
    from: 'a'.repeat(40),
    to: 'b'.repeat(40),
    path: 'file.ts',
    patchHash: 'c'.repeat(64),
    hunkIds: ['d'.repeat(64)],
  };
  const original = createTextAttachment(
    'changes.patch',
    'text/plain',
    'captured original',
    provenance,
  );
  const replacement = createTextAttachment(
    'changes.patch',
    'text/plain',
    'replacement preview',
    provenance,
  );
  fixture.read.mockResolvedValue({ state: 'stale', current: replacement });
  fixture.recapture.mockResolvedValue(replacement);
  const onChange = vi.fn(),
    openDocument = vi.fn(),
    openTerminal = vi.fn();
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const click = async (label: string) => {
    const button = [...document.querySelectorAll('button')].find(
      (item) => item.textContent === label,
    );
    expect(button).toBeDefined();
    await act(async () => button?.click());
  };
  try {
    await act(async () =>
      root.render(
        <SourceNavigationContext.Provider value={{ openDocument, openTerminal }}>
          <SourceAttachments value={[original]} onChange={onChange} />
        </SourceNavigationContext.Provider>,
      ),
    );
    await click('Context.openSource');
    expect(document.querySelector('[role=dialog]')?.textContent).toContain('captured original');
    expect(document.querySelector('[role=dialog]')?.textContent).not.toContain(
      'replacement preview',
    );
    expect(document.querySelector('[role=dialog] textarea:not([readonly])')).toBeNull();
    expect(openDocument).not.toHaveBeenCalled();
    expect(openTerminal).not.toHaveBeenCalled();
    await click('Context.close');
    await click('Context.replaceCapture');
    expect(document.querySelector('[role=dialog]')?.textContent).toContain('replacement preview');
    expect(onChange).not.toHaveBeenCalled();
    await click('Context.cancel');
    expect(onChange).not.toHaveBeenCalled();
    await click('Context.replaceCapture');
    await click('Context.confirmReplacement');
    expect(onChange).toHaveBeenCalledExactlyOnceWith([replacement]);
    expect(original.text).toBe('captured original');
    await click('Context.replaceCapture');
    fixture.services = {};
    await act(async () =>
      root.render(
        <SourceNavigationContext.Provider value={{ openDocument, openTerminal }}>
          <SourceAttachments value={[original]} onChange={onChange} />
        </SourceNavigationContext.Provider>,
      ),
    );
    await click('Context.confirmReplacement');
    expect(onChange).toHaveBeenCalledTimes(1);
    const preview = createTextAttachment('preview.txt', 'text/plain', 'frozen preview', {
      kind: 'preview',
      target: {
        hostId: 'host',
        projectId: 'project',
        sessionId: 'session',
        bindingId: 'binding',
        copyGeneration: 1,
      },
      leaseId: 'preview',
      url: 'http://127.0.0.2:4318/page',
      capturedAt: '2026-10-23T00:00:00.000Z',
      pageRevision: 2,
      sourceRevision: null,
    });
    fixture.read.mockResolvedValue({ state: 'current', applies: 'unknown', current: preview });
    fixture.recapture.mockClear();
    await act(async () => root.render(<SourceAttachments value={[preview]} onChange={onChange} />));
    expect(container.textContent).toContain('Context.applies.unknown');
    expect(container.textContent).toContain('Context.previewRecapture');
    expect(container.textContent).toContain('http://127.0.0.2:4318/page');
    expect(container.textContent).not.toContain('Context.replaceCapture');
    expect(container.querySelector('a')).toBeNull();
    await click('Context.openSource');
    expect(document.querySelector('[role=dialog]')?.textContent).toContain('frozen preview');
    expect(fixture.recapture).not.toHaveBeenCalled();
    expect(onChange).toHaveBeenCalledTimes(1);
  } finally {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  }
});
