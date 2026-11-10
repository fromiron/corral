// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { RuntimeCheckpointView } from '@corral/contracts';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { IntlProvider } from 'use-intl';
import { afterEach, expect, it, vi } from 'vitest';
import en from '../../../../packages/react/src/messages/en.json' with { type: 'json' };
import ko from '../../../../packages/react/src/messages/ko.json' with { type: 'json' };
import { RuntimeRecovery } from './RuntimeRecovery.tsx';

const fixture = vi.hoisted(() => ({ services: {} as Record<string, unknown> }));
vi.mock('../services.tsx', () => ({ useServices: () => fixture.services }));
vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => () => {},
  useRouter: () => ({ invalidate: async () => {} }),
}));

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

/**
 * Every blocker the coordinator can put on a runtime checkpoint, read from its source: the
 * preview pushes them one by one, and the list falls back to one when a checkpoint cannot be
 * loaded. The contract types them as strings, so the catalog has nothing else to check against.
 */
function serverBlockers() {
  const source = readFileSync(
    join(import.meta.dirname, '../../../../packages/core/src/coordinator.ts'),
    'utf8',
  );
  const pushed = [...source.matchAll(/\bblockers\.push\(\s*'([a-z_]+)'\s*\)/g)].map(
    (match) => match[1] as string,
  );
  const listed = [...source.matchAll(/\bblockers:\s*\[([^\]]*)\]/g)].flatMap((match) =>
    [...(match[1] ?? '').matchAll(/'([a-z_]+)'/g)].map((value) => value[1] as string),
  );
  return [...new Set([...pushed, ...listed])].sort();
}

it('has a sentence in both catalogs for every blocker the server can send', () => {
  const blockers = serverBlockers();
  // The source still reads as this test expects it to.
  expect(blockers).toEqual(
    expect.arrayContaining(['already_resumed', 'checkpoint_corrupt', 'content_released']),
  );
  for (const [locale, messages] of [
    ['en', en],
    ['ko', ko],
  ] as const) {
    const catalog = messages.RuntimeRecovery.blockers as Record<string, string>;
    const missing = blockers.filter((blocker) => !catalog[blocker]?.trim());
    expect({ locale, missing }).toEqual({ locale, missing: [] });
  }
});

it('says why a checkpoint whose text was released cannot be continued', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const checkpoint = {
    checkpointId: 'checkpoint_1',
    contextHash: 'a'.repeat(64),
    tree: null,
    runtime: 'pi-core',
    createdAt: '2026-11-10T00:00:00Z',
    ready: false,
    blockers: ['content_released'],
  } as unknown as RuntimeCheckpointView;
  fixture.services = { workspaces: { runtimeCheckpoints: async () => [checkpoint] } };
  for (const [locale, messages] of [
    ['en', en],
    ['ko', ko],
  ] as const) {
    const container = document.createElement('div');
    const root = createRoot(container);
    cleanups.push(async () => act(async () => root.unmount()));
    await act(async () =>
      root.render(
        <IntlProvider locale={locale} messages={messages} timeZone="UTC">
          <RuntimeRecovery runId="run_1" sessionId={null} />
        </IntlProvider>,
      ),
    );
    expect(container.textContent).toContain(messages.RuntimeRecovery.blockers.content_released);
    expect(container.textContent).not.toContain('RuntimeRecovery.blockers');
  }
});
