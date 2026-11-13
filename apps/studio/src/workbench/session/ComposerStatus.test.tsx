// @vitest-environment jsdom
import { act, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { IntlProvider } from 'use-intl';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import en from '../../../../../packages/react/src/messages/en.json' with { type: 'json' };
import ko from '../../../../../packages/react/src/messages/ko.json' with { type: 'json' };
import { resolveIntent, type SteerTarget } from '../composerIntent.ts';
import { ComposerHeader } from './ComposerStatus.tsx';
import { KeyHint } from './composer/SendControls.tsx';

vi.mock('../../services.tsx', () => ({ useServices: () => ({}) }));
vi.mock('../../pages/FilesViews.tsx', () => ({ WORKSPACE_CHANGED: 'workspace-changed' }));
vi.mock('../widgets/ComposerStats.tsx', () => ({ ComposerStats: () => null }));

const cleanup: (() => void)[] = [];
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('matchMedia', () => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  }));
});
afterEach(() => {
  for (const dispose of cleanup.splice(0)) act(dispose);
  vi.unstubAllGlobals();
});

async function render(locale: 'en' | 'ko', node: ReactNode) {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  cleanup.push(() => {
    root.unmount();
    container.remove();
  });
  await act(async () =>
    root.render(
      <IntlProvider locale={locale} messages={locale === 'en' ? en : ko} timeZone="UTC">
        {node}
      </IntlProvider>,
    ),
  );
  return container.textContent ?? '';
}

const words = (text: string) => text.split(/[\s·]+/).filter(Boolean);
const writer: SteerTarget = { id: 'w', label: 'Writer', interruptible: true, awaiting: false };

// The line above the input does not say the run's state again; the composer's send keys say
// what a message does, never in a run state's words (presence.md "한 화면에 한 번").
it.each(['en', 'ko'] as const)(
  'the send keys during a run do not repeat a run state word in %s',
  async (locale) => {
    const messages = locale === 'en' ? en : ko;
    const states = ['working', 'pausing', 'paused', 'awaiting_user'] as const;
    const stateWords = new Set(states.flatMap((state) => words(messages.Presence.state[state])));
    for (const targets of [[writer], [{ ...writer, interruptible: false }], []]) {
      const { keys, situation } = resolveIntent({
        running: true,
        targets,
        lead: 'w',
        chosenTarget: null,
        lock: null,
        chosen: null,
      });
      const line = await render(
        locale,
        <KeyHint keys={keys} situation={situation} sendKey="enter" />,
      );
      expect(line).toContain(messages.Composer.keyHint[keys.send]);
      expect(words(line).filter((word) => stateWords.has(word))).toEqual([]);
    }
  },
);

it('the status lead no longer chooses the send or the target', async () => {
  const line = await render(
    'en',
    <ComposerHeader choosingAuto={false} onCancelAuto={() => {}} intent="steer" />,
  );
  expect(line).toBe('');
});
