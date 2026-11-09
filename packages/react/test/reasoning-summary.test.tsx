import { render, within } from '@testing-library/react';
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

describe('ReasoningSummary', () => {
  it('says an automatic request with judgment off went out on the provider default', () => {
    const off = summary({
      reasoning: {
        requested: { mode: 'auto' },
        resolved: null,
        source: 'off',
        preparationId: 'prep_1',
      },
      reasoningWire: { kind: 'effort', value: null },
    });
    expect(off.textContent).toContain('Automatic → Provider default');
    expect(off.textContent).toContain('Judgment off');
    expect(off.getAttribute('title')).toBe('prep_1');
    expect(
      summary(
        {
          reasoning: {
            requested: { mode: 'auto' },
            resolved: null,
            source: 'off',
            preparationId: 'prep_2',
          },
        },
        'ko',
      ).textContent,
    ).toContain('판정 꺼짐');
  });

  it('names a compaction request kept at medium by the internal policy', () => {
    const compaction = summary({
      reasoning: {
        requested: { mode: 'auto' },
        resolved: 'medium',
        source: 'internal-policy',
        preparationId: 'prep_3',
      },
      reasoningWire: { kind: 'effort', value: 'medium' },
    });
    expect(compaction.textContent).toContain('Automatic → medium');
    expect(compaction.textContent).toContain('Compaction policy');
  });
});
