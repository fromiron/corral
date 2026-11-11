// @vitest-environment jsdom
import type { SessionIntent } from '@corral/core';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { IntlProvider } from 'use-intl';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import en from '../../../../../packages/react/src/messages/en.json' with { type: 'json' };
import ko from '../../../../../packages/react/src/messages/ko.json' with { type: 'json' };
import { ComposerHeader } from './ComposerStatus.tsx';

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

async function header(locale: 'en' | 'ko', intent: SessionIntent) {
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
        <ComposerHeader
          choosingAuto={false}
          onCancelAuto={() => {}}
          // While a run is in progress the next message is a next request or an instruction.
          allowed={['next', 'steer']}
          blocked={null}
          intent={intent}
          onChooseIntent={() => {}}
          steerTarget=""
          targets={[]}
          targetName={(id) => id}
          onChooseTarget={() => {}}
        />
      </IntlProvider>,
    ),
  );
  return container.textContent ?? '';
}

const words = (text: string) => text.split(/[\s·]+/).filter(Boolean);

// workbench.md: the line above the input does not show an in-progress state again; the top
// bar's pill says it. The send mode it leads with must not read as that state's word.
it.each(['en', 'ko'] as const)(
  'the send mode during a run does not repeat a run state word in %s',
  async (locale) => {
    const messages = locale === 'en' ? en : ko;
    const states = ['running', 'pausing', 'paused', 'awaiting_user'] as const;
    const stateWords = new Set(states.flatMap((state) => words(messages.Status[state])));
    // A next request sent now waits behind the run (`queue`); it is still named a next request.
    for (const [intent, choice] of [
      ['queue', 'next'],
      ['steer', 'steer'],
    ] as const) {
      const line = await header(locale, intent);
      expect(line).toContain(messages.Sessions.intentShort[choice]);
      expect(line).not.toContain(messages.Sessions.intentShort.queue);
      expect(words(line).filter((word) => stateWords.has(word))).toEqual([]);
    }
  },
);
