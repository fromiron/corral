// @vitest-environment jsdom
import { act, createRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { IntlProvider } from 'use-intl';
import { expect, it, vi } from 'vitest';
import messages from '../../../../packages/react/src/messages/en.json' with { type: 'json' };
import type { AppCommand } from '../commandRegistry.ts';
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

// workbench.md: a `/` command that takes a value is written after its name and run by the send
// key; picking it from the menu leaves the name and a space for the value.
async function withCommands(sendKey: 'enter' | 'mod-enter', initial: string) {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    callback(0);
    return 0;
  });
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const input = createRef<HTMLTextAreaElement>();
  const onSend = vi.fn();
  const takes = vi.fn();
  const compact = vi.fn();
  const commands: AppCommand[] = [
    {
      id: 'auto',
      title: 'Set the context window',
      group: 'Request',
      slash: 'autocompaction',
      takesValue: true,
      run: takes,
    },
    { id: 'compact', title: 'Compact', group: 'Run', slash: 'compact', run: compact },
  ];
  let text = initial;
  function Harness() {
    const [value, setValue] = useState(initial);
    text = value;
    return (
      <IntlProvider locale="en" messages={messages}>
        <ComposerInput
          value={value}
          onChange={setValue}
          onKeyDown={() => {}}
          sendKey={sendKey}
          onSend={onSend}
          commands={commands}
          searchMentions={async () => []}
          onMention={(item) => item}
          inputRef={input}
          placeholder="Request"
          label="Request"
        />
      </IntlProvider>
    );
  }
  await act(async () => root.render(<Harness />));
  await act(async () => {
    input.current?.focus();
    input.current?.setSelectionRange(initial.length, initial.length);
    input.current?.dispatchEvent(new KeyboardEvent('keyup', { key: 'End', bubbles: true }));
  });
  const press = async (init: KeyboardEventInit = {}) => {
    await act(async () => {
      input.current?.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true, ...init }),
      );
    });
  };
  const dispose = async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  };
  return { input, onSend, takes, compact, press, dispose, text: () => text };
}

it('picking a command that takes a value leaves its name and a space, and runs nothing yet', async () => {
  const view = await withCommands('enter', '/autoc');
  try {
    expect(view.input.current?.getAttribute('aria-expanded')).toBe('true');
    await view.press();
    expect(view.text()).toBe('/autocompaction ');
    expect(view.takes).not.toHaveBeenCalled();
    expect(view.onSend).not.toHaveBeenCalled();
    // The menu is closed now: the send key goes to the composer, which runs the command.
    await view.press();
    expect(view.onSend).toHaveBeenCalledWith('send');
  } finally {
    await view.dispose();
  }
});

it.each([
  ['enter', {}],
  ['mod-enter', { ctrlKey: true }],
] as const)(
  'with the %s send key, the send key on a value command’s whole name sends it to the composer',
  async (sendKey, modifiers) => {
    const view = await withCommands(sendKey, '/autocompaction');
    try {
      expect(view.input.current?.getAttribute('aria-expanded')).toBe('true');
      await view.press(modifiers);
      expect(view.onSend).toHaveBeenCalledWith('send');
      expect(view.text()).toBe('/autocompaction');
    } finally {
      await view.dispose();
    }
  },
);

it('Enter in the menu still completes a value command when Enter is not the send key, and runs a command without a value at once', async () => {
  const typed = await withCommands('mod-enter', '/autocompaction');
  try {
    await typed.press();
    expect(typed.text()).toBe('/autocompaction ');
    expect(typed.onSend).not.toHaveBeenCalled();
  } finally {
    await typed.dispose();
  }
  const plain = await withCommands('enter', '/compact');
  try {
    await plain.press();
    expect(plain.compact).toHaveBeenCalledTimes(1);
    expect(plain.text()).toBe('');
    expect(plain.onSend).not.toHaveBeenCalled();
  } finally {
    await plain.dispose();
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
