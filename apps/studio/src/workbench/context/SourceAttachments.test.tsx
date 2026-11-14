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

it('shows a reply quote as a chip in the chip row and keeps the other captures in order around it', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  fixture.read.mockReset();
  fixture.read.mockResolvedValue({ state: 'current' });
  const first = createTextAttachment('first.txt', 'text/plain', 'first');
  const quote = createTextAttachment('quote.txt', 'text/plain', 'quoted passage', {
    kind: 'reply',
    runId: 'run_quoted',
    modelCallId: 'call_quoted',
    start: 0,
    end: 14,
    prefix: '',
    suffix: '',
  });
  const last = createTextAttachment('last.txt', 'text/plain', 'last');
  const onChange = vi.fn();
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const button = (label: string) =>
    [...container.querySelectorAll('button')].filter(
      (item) => item.getAttribute('aria-label') === label,
    );
  try {
    await act(async () =>
      root.render(<SourceAttachments value={[first, quote, last]} onChange={onChange} />),
    );
    // The quote is a chip, never a source row that reads the reply back.
    expect(container.querySelectorAll('details')).toHaveLength(2);
    expect(container.textContent).toContain('quoted passage');
    expect(fixture.read).not.toHaveBeenCalledWith(expect.anything(), quote);
    // The chip list is named, so its chips are read as the request's quotes.
    const chips = container.querySelector('li')?.closest('ul');
    expect(chips?.getAttribute('aria-label')).toBe('Composer.quotes');
    await act(async () => button('Context.removeCapture')[0]?.click());
    expect(onChange).toHaveBeenLastCalledWith([quote, last]);
    await act(async () => button('Composer.removeQuote')[0]?.click());
    expect(onChange).toHaveBeenLastCalledWith([first, last]);
  } finally {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  }
});
