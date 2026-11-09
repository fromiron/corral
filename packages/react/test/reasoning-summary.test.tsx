import type { RouteRecord } from '@corral/contracts';
import { act, render, screen, within } from '@testing-library/react';
import { IntlProvider } from 'use-intl';
import { describe, expect, it } from 'vitest';
import { ReasoningSummary } from '../src/components/ReasoningSummary.tsx';
import messages from '../src/messages/en.json' with { type: 'json' };
import ko from '../src/messages/ko.json' with { type: 'json' };

type Call = Parameters<typeof ReasoningSummary>[0]['call'];
const summary = (call: Call, locale: 'en' | 'ko' = 'en') => {
  const { container } = render(
    <IntlProvider locale={locale} messages={locale === 'en' ? messages : ko} timeZone="UTC">
      <ReasoningSummary call={call} />
    </IntlProvider>,
  );
  return within(container).getByTestId('reasoning-summary');
};

const HASH = 'a'.repeat(64);
const route = (overrides: Partial<RouteRecord> = {}): RouteRecord => ({
  routeId: 'route_1',
  engine: 'local',
  application: 'active',
  settingsRevision: HASH,
  candidates: ['low', 'medium', 'high', 'xhigh'],
  recommended: 'low',
  probabilities: { low: 0.62, medium: 0.3, high: 0.08 },
  probabilityMeaning: 'choice-distribution',
  engineIdentity: 'd1-2b-q4km-llama-b12189-linux-x64-cpu#1',
  questionVersion: 'effort-v1',
  questionHash: HASH,
  serializerVersion: 'd1-systemone-v1',
  frame: {
    kind: 'd1-exact',
    hash: HASH,
    stateUnits: 140,
    inputUnits: 171,
    included: 3,
    omitted: 0,
    truncated: 0,
  },
  timing: { deadlineMs: 5000, packMs: 3, countMs: 12, engineMs: 405, callerWaitMs: 420 },
  device: { requested: 'cpu', actual: 'cpu', host: 'build-host', threads: 4 },
  usage: { inputTokens: 171, billableUnits: null },
  ...overrides,
});

describe('ReasoningSummary', () => {
  it('shows a Local recommendation as recommended → applied with the wait', () => {
    const line = summary({
      reasoning: {
        preparationId: 'prep_1',
        requested: { mode: 'auto' },
        resolved: 'low',
        source: 'router',
        route: route(),
      },
      reasoningWire: { kind: 'effort', value: 'low' },
    });
    expect(line.textContent).toBe('Local · CPU · Recommended low → applied low · 420ms');
  });

  it('a timeout says what went instead and never reads as an applied recommendation', () => {
    const call: Call = {
      reasoning: {
        preparationId: 'prep_2',
        requested: { mode: 'auto' },
        resolved: null,
        source: 'fallback',
        route: route({
          recommended: null,
          probabilities: null,
          probabilityMeaning: null,
          fallback: { reason: 'timeout', target: { kind: 'provider-default' } },
          timing: { deadlineMs: 5000, packMs: 3, countMs: 12, engineMs: null, callerWaitMs: 5000 },
        }),
      },
    };
    expect(summary(call).textContent).toBe('Local · CPU · Timed out → Provider default');
    expect(summary(call, 'ko').textContent).toBe('Local · CPU · 시간 초과 → 공급자 기본값');
  });

  it('a decision API that was not called for lack of context says so', () => {
    const line = summary({
      reasoning: {
        preparationId: 'prep_3',
        requested: { mode: 'auto' },
        resolved: null,
        source: 'fallback',
        route: route({
          engine: 'api',
          engineIdentity: 'openai-decisions/gpt-6-luna',
          recommended: null,
          probabilities: null,
          probabilityMeaning: null,
          device: null,
          fallback: {
            reason: 'insufficient-context',
            insufficient: 'required-content-over-budget',
            target: { kind: 'provider-default' },
          },
        }),
      },
    });
    expect(line.textContent).toBe(
      'Decision API · OpenAI Decisions · Not enough context · not called → Provider default',
    );
  });

  it('says an automatic request with judgment off was not judged', () => {
    const off = summary({
      reasoning: {
        requested: { mode: 'auto' },
        resolved: null,
        source: 'off',
        preparationId: 'prep_4',
      },
      reasoningWire: { kind: 'effort', value: null },
    });
    expect(off.textContent).toBe('Off · Not judged');
    expect(off.getAttribute('title')).toBe('prep_4');
    expect(
      summary(
        {
          reasoning: {
            requested: { mode: 'auto' },
            resolved: null,
            source: 'off',
            preparationId: 'prep_5',
          },
        },
        'ko',
      ).textContent,
    ).toBe('끄기 · 판정 안 함');
  });

  it('opens the distribution, device, time and a late answer from the line', async () => {
    const line = summary({
      reasoning: {
        preparationId: 'prep_6',
        requested: { mode: 'auto' },
        resolved: 'medium',
        source: 'fallback',
        route: route({
          recommended: null,
          fallback: { reason: 'timeout', target: { kind: 'fixed', effort: 'medium' } },
        }),
      },
      reasoningWire: { kind: 'effort', value: 'medium' },
      reasoningSettled: {
        basis: 'native-response-complete',
        physicalOccupiedMs: 6200,
        lateResult: true,
        lateSelected: 'high',
      },
    });
    expect(line.tagName).toBe('BUTTON');
    await act(async () => line.click());
    const detail = await screen.findByRole('dialog');
    const text = detail.textContent ?? '';
    expect(text).toContain('Choice distribution');
    expect(text).toContain('low 62% · medium 30% · high 8%');
    expect(text).toContain('CPU · 4 threads · build-host');
    expect(text).toContain('Timed out → medium');
    expect(text).toContain('high arrived after the request went out');
    expect(text).toContain('171 tokens');
    expect(text).toContain('d1-2b-q4km-llama-b12189-linux-x64-cpu#1');
  });

  it('names a compaction request kept at medium by the internal policy', () => {
    const compaction = summary({
      reasoning: {
        requested: { mode: 'auto' },
        resolved: 'medium',
        source: 'internal-policy',
        preparationId: 'prep_7',
      },
      reasoningWire: { kind: 'effort', value: 'medium' },
    });
    expect(compaction.textContent).toContain('Automatic → medium');
    expect(compaction.textContent).toContain('Compaction policy');
  });
});
