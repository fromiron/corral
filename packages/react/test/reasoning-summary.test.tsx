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
  it('names a local model judgment and an abstained one', () => {
    const judged = summary({
      reasoning: {
        requested: { mode: 'auto' },
        resolved: 'high',
        source: 'local-model',
        judged: 'high',
        policyVersion: 'corral-effort-v1',
        judgeVersion: 'corral-local-ai-1+effort-v1',
        preparationId: 'prep_1',
      },
      reasoningWire: { kind: 'effort', value: 'high' },
    });
    expect(judged.textContent).toContain('Local model applied');
    expect(judged.textContent).not.toContain('ONNX');
    const abstained = summary({
      reasoning: {
        requested: { mode: 'auto' },
        resolved: 'medium',
        source: 'fallback',
        fallback: 'abstained',
        preparationId: 'prep_2',
      },
      reasoningWire: { kind: 'effort', value: 'medium' },
    });
    expect(abstained.textContent).toContain('Judge not confident');
    expect(
      summary(
        {
          reasoning: {
            requested: { mode: 'auto' },
            resolved: 'medium',
            source: 'fallback',
            fallback: 'abstained',
            preparationId: 'prep_3',
          },
        },
        'ko',
      ).textContent,
    ).toContain('판정 보류');
  });

  it('still shows a run judged by the removed judge model', () => {
    const old = summary({
      reasoning: {
        requested: { mode: 'auto' },
        resolved: 'high',
        source: 'local-model',
        judged: 'xhigh',
        policyVersion: 'mixdog-relative-v1',
        judgeVersion: 'effort-judge-v6',
        preparationId: 'prep_4',
      },
      reasoningWire: { kind: 'effort', value: 'high' },
    });
    expect(old.textContent).toContain('Local model applied');
    expect(old.textContent).toContain('xhigh → high');
    expect(old.getAttribute('title')).toContain('effort-judge-v6');
  });
});
