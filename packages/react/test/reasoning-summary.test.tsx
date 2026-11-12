import type { RouteRecord } from '@corral/contracts';
import { act, render, screen, within } from '@testing-library/react';
import { IntlProvider } from 'use-intl';
import { describe, expect, it } from 'vitest';
import { ReasoningSummary } from '../src/components/ReasoningSummary.tsx';
import messages from '../src/messages/en.json' with { type: 'json' };
import ko from '../src/messages/ko.json' with { type: 'json' };

type Call = Parameters<typeof ReasoningSummary>[0]['call'];
const summary = (call: Call, locale: 'en' | 'ko' = 'en', open = true) => {
  const { container } = render(
    <IntlProvider locale={locale} messages={locale === 'en' ? messages : ko} timeZone="UTC">
      <ReasoningSummary call={call} open={open} />
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

  it('shows the device the judge actually used', () => {
    const line = summary({
      reasoning: {
        preparationId: 'prep_gpu',
        requested: { mode: 'auto' },
        resolved: 'low',
        source: 'router',
        route: route({
          device: { requested: 'vulkan', actual: 'Vulkan0', host: 'build-host', threads: 4 },
        }),
      },
      reasoningWire: { kind: 'effort', value: 'low' },
    });
    expect(line.textContent).toBe('Local · VULKAN0 · Recommended low → applied low · 420ms');
  });

  it('shows measured times as whole milliseconds', async () => {
    const line = summary({
      reasoning: {
        preparationId: 'prep_ms',
        requested: { mode: 'auto' },
        resolved: 'low',
        source: 'router',
        route: route({
          timing: {
            deadlineMs: 5000,
            packMs: 32.048,
            countMs: 30.753,
            engineMs: 3593.063,
            callerWaitMs: 3625.153,
          },
        }),
      },
      reasoningSettled: {
        basis: 'native-response-complete',
        physicalOccupiedMs: 3624.906,
        lateResult: false,
        lateSelected: null,
      },
    });
    expect(line.textContent).toBe('Local · CPU · Recommended low → applied low · 3,625ms');
    await act(async () => line.click());
    const text = (await screen.findByRole('dialog')).textContent ?? '';
    expect(text).not.toMatch(/\d\.\d/);
    expect(text).toContain('3,625ms');
    expect(text).toContain('3,593ms');
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

  it('a request without a payload record is not yet verified while open, and not verified once it ends', async () => {
    const fixed: Call = {
      reasoning: {
        preparationId: 'prep_8',
        requested: { mode: 'fixed', level: 'high' },
        resolved: 'high',
        source: 'fixed',
      },
    };
    expect(summary(fixed, 'ko', true).textContent).toContain('요청 확인: 아직 확인 안 됨');
    const ended = summary(fixed, 'ko', false).textContent;
    expect(ended).toContain('요청 확인: 확인 안 됨');
    expect(ended).not.toContain('아직');
    expect(summary(fixed, 'en', false).textContent).toContain('Payload verified: not verified');

    const judged = summary(
      {
        reasoning: {
          preparationId: 'prep_9',
          requested: { mode: 'auto' },
          resolved: 'low',
          source: 'router',
          route: route(),
        },
      },
      'ko',
      false,
    );
    await act(async () => judged.click());
    const detail = (await screen.findByRole('dialog')).textContent ?? '';
    expect(detail).toContain('요청 확인확인 안 됨');
    expect(detail).not.toContain('아직');
  });
});
