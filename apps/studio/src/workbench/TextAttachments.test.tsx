// @vitest-environment jsdom
import { createTextAttachment } from '@corral/core';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { TextAttachmentPicker } from './TextAttachments.tsx';

vi.mock('use-intl', () => ({ useTranslations: () => (key: string) => key }));
afterEach(() => vi.unstubAllGlobals());

it('[TC-WBD-007-N] a file upload with identical text preserves a captured source with different provenance', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const text = 'same body';
  const captured = createTextAttachment('selection.txt', 'text/plain', text, {
    kind: 'check',
    hostId: 'host',
    projectId: 'project',
    sessionId: 'session',
    verificationId: 'check',
    commandId: 'test',
    tree: 'a'.repeat(40),
  });
  const file = new File([text], 'selection.txt', { type: 'text/plain' });
  Object.defineProperty(file, 'arrayBuffer', {
    value: async () => new TextEncoder().encode(text).buffer,
  });
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const onChange = vi.fn();
  try {
    await act(async () =>
      root.render(
        <TextAttachmentPicker
          value={[captured]}
          onChange={onChange}
          onLoading={() => {}}
          disabled={false}
          enabled
        />,
      ),
    );
    const input = container.querySelector('input');
    if (!input) throw new Error('Missing file picker');
    Object.defineProperty(input, 'files', { value: [file] });
    await act(async () => input.dispatchEvent(new Event('change', { bubbles: true })));
    expect(onChange).toHaveBeenCalledOnce();
    expect(onChange.mock.calls[0]?.[0]).toEqual([
      captured,
      createTextAttachment('selection.txt', 'text/plain', text),
    ]);
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});
