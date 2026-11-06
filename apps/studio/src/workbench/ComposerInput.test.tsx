// @vitest-environment jsdom
import { act, createRef } from 'react';
import { createRoot } from 'react-dom/client';
import { IntlProvider } from 'use-intl';
import { expect, it, vi } from 'vitest';
import messages from '../../../../packages/react/src/messages/en.json' with { type: 'json' };
import { ComposerInput } from './ComposerInput.tsx';

it('closes reference suggestions when focus leaves the request for a reference chip', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.useFakeTimers();
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const input = createRef<HTMLTextAreaElement>();
  try {
    await act(async () =>
      root.render(
        <IntlProvider locale="en" messages={messages}>
          <ComposerInput
            value="@README.md"
            onChange={() => {}}
            onKeyDown={() => {}}
            commands={[]}
            searchMentions={async () => []}
            onMention={(item) => item}
            inputRef={input}
            placeholder="Request"
            label="Request"
          />
          <button type="button">Remove reference</button>
        </IntlProvider>,
      ),
    );
    await act(async () => {
      input.current?.focus();
      input.current?.setSelectionRange(10, 10);
      input.current?.dispatchEvent(new KeyboardEvent('keyup', { key: 'd', bubbles: true }));
    });
    await act(async () => vi.advanceTimersByTimeAsync(80));
    expect(input.current?.getAttribute('aria-expanded')).toBe('true');
    await act(async () => container.querySelector('button')?.focus());
    expect(input.current?.getAttribute('aria-expanded')).toBe('false');
    expect(document.querySelector('[role="listbox"]')).toBeNull();
  } finally {
    await act(async () => root.unmount());
    container.remove();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  }
});
