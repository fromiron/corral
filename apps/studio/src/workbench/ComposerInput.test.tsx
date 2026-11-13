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
            sendKey="enter"
            onSend={() => {}}
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

// features/composer-flow.md "전송": the send key, the interrupt key and Alt+Enter, by the send
// key the person chose; an IME composition never sends.
async function keyed(sendKey: 'enter' | 'mod-enter') {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const input = createRef<HTMLTextAreaElement>();
  const onSend = vi.fn();
  const onKeyDown = vi.fn();
  await act(async () =>
    root.render(
      <IntlProvider locale="en" messages={messages}>
        <ComposerInput
          value="Run the tests too"
          onChange={() => {}}
          onKeyDown={onKeyDown}
          sendKey={sendKey}
          onSend={onSend}
          commands={[]}
          searchMentions={async () => []}
          onMention={(item) => item}
          inputRef={input}
          placeholder="Request"
          label="Request"
        />
      </IntlProvider>,
    ),
  );
  const press = async (init: KeyboardEventInit & { keyCode?: number }) => {
    const { keyCode, ...rest } = init;
    const event = new KeyboardEvent('keydown', {
      key: 'Enter',
      bubbles: true,
      cancelable: true,
      ...rest,
    });
    if (keyCode !== undefined) Object.defineProperty(event, 'keyCode', { value: keyCode });
    await act(async () => {
      input.current?.dispatchEvent(event);
    });
    return event;
  };
  const dispose = async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  };
  return { input, onSend, onKeyDown, press, dispose };
}

it.each([
  ['enter', {}, 'send'],
  ['enter', { ctrlKey: true }, 'interrupt'],
  ['enter', { metaKey: true }, 'interrupt'],
  ['enter', { altKey: true }, 'queue'],
  ['mod-enter', { ctrlKey: true }, 'send'],
  ['mod-enter', { metaKey: true }, 'send'],
  ['mod-enter', { ctrlKey: true, shiftKey: true }, 'interrupt'],
  ['mod-enter', { altKey: true }, 'queue'],
] as const)('with the %s send key, Enter %o is %s', async (sendKey, modifiers, role) => {
  const view = await keyed(sendKey);
  try {
    const event = await view.press(modifiers);
    expect(view.onSend).toHaveBeenCalledTimes(1);
    expect(view.onSend).toHaveBeenCalledWith(role);
    expect(event.defaultPrevented).toBe(true);
  } finally {
    await view.dispose();
  }
});

it.each([
  ['enter', { shiftKey: true }],
  ['mod-enter', {}],
  ['mod-enter', { shiftKey: true }],
] as const)('with the %s send key, Enter %o keeps the line break', async (sendKey, modifiers) => {
  const view = await keyed(sendKey);
  try {
    const event = await view.press(modifiers);
    expect(view.onSend).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
  } finally {
    await view.dispose();
  }
});

it.each(['enter', 'mod-enter'] as const)(
  'never sends during an IME composition, whatever the key (%s send key)',
  async (sendKey) => {
    const view = await keyed(sendKey);
    try {
      const keys = [
        {},
        { ctrlKey: true },
        { metaKey: true },
        { altKey: true },
        { ctrlKey: true, shiftKey: true },
      ];
      // The browser says the key belongs to the composition.
      for (const modifiers of keys) await view.press({ ...modifiers, isComposing: true });
      // Older engines say it only through keyCode 229.
      for (const modifiers of keys) await view.press({ ...modifiers, keyCode: 229 });
      // Between compositionstart and compositionend, a key that does not say so itself.
      await act(async () => {
        view.input.current?.dispatchEvent(
          new CompositionEvent('compositionstart', { bubbles: true }),
        );
      });
      for (const modifiers of keys) await view.press(modifiers);
      expect(view.onSend).not.toHaveBeenCalled();
      await act(async () => {
        view.input.current?.dispatchEvent(
          new CompositionEvent('compositionend', { bubbles: true }),
        );
      });
      await view.press(sendKey === 'enter' ? {} : { ctrlKey: true });
      expect(view.onSend).toHaveBeenCalledTimes(1);
    } finally {
      await view.dispose();
    }
  },
);
