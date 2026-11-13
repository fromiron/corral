import type { AdviceSeverity } from '@corral/contracts';
import { describe, expect, it } from 'vitest';
import {
  ADVICE_FILLER_PHRASES,
  ADVICE_HISTORY_LIMIT,
  type AdviceGuardState,
  admit,
  beginReview,
  emptyGuard,
  normalizeAdviceNote,
} from '../src/advisor/guard.ts';

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

/** Admit a list of notes at one severity, failing loudly if any is not admitted. */
function admitAll(state: AdviceGuardState, notes: string[], severity: AdviceSeverity) {
  let current = state;
  for (const note of notes) {
    const result = admit(current, { severity, note });
    expect(result.outcome, note).toBe('admitted');
    current = result.state;
  }
  return current;
}

describe('advice note normalisation', () => {
  it('gives the three spellings of stop one key', () => {
    expect(normalizeAdviceNote('Stop.')).toBe('stop');
    expect(normalizeAdviceNote('*stop*')).toBe('stop');
    expect(normalizeAdviceNote('  STOP ')).toBe('stop');
  });

  it('folds full-width and mixed-case text', () => {
    expect(normalizeAdviceNote('ＬＧＴＭ！')).toBe('lgtm');
    expect(normalizeAdviceNote('Check The  CACHE-key')).toBe('check the cache key');
  });

  it('keeps Korean letters and digits and drops punctuation', () => {
    expect(normalizeAdviceNote('  문제 없음, 계속!! ')).toBe('문제 없음 계속');
    expect(normalizeAdviceNote('3번째 호출(재시도)')).toBe('3번째 호출 재시도');
  });
});

describe('advice gatekeeper: noise', () => {
  it('treats every filler phrase as noise, whatever its spelling', () => {
    for (const phrase of ADVICE_FILLER_PHRASES) {
      for (const spelled of [phrase, `${phrase.toUpperCase()}.`, `  *${phrase}*  `]) {
        const result = admit(emptyGuard(), { severity: 'concern', note: spelled });
        expect(result.outcome, spelled).toBe('noise');
      }
    }
  });

  it('lists the 21 unsplittable filler phrases', () => {
    expect(ADVICE_FILLER_PHRASES).toHaveLength(21);
    expect(ADVICE_FILLER_PHRASES).not.toContain('no issue continue');
    expect(ADVICE_FILLER_PHRASES).not.toContain('문제 없음 계속');
  });

  it('treats a note made only of filler phrases as noise', () => {
    for (const note of [
      'LGTM, continue.',
      'ok. looks good',
      '문제 없음, 계속',
      '확인. 계속 진행',
      '좋습니다 문제없음',
      'No issues — keep going!',
      'ok ok ok',
      'no issue continue',
    ]) {
      expect(admit(emptyGuard(), { severity: 'concern', note }).outcome, note).toBe('noise');
    }
  });

  it('does not call a note noise when any word is left over', () => {
    for (const note of [
      'stop using the cache here',
      'ok, but the cache key ignores the locale',
      '계속 진행하기 전에 캐시 키를 확인하세요',
      'looks good except the retry count',
      'no',
      'looks',
      'good',
      'ok cache',
    ]) {
      expect(admit(emptyGuard(), { severity: 'concern', note }).outcome, note).toBe('admitted');
    }
  });

  it('lists the required filler phrases', () => {
    for (const phrase of [
      'stop',
      'done',
      'ok',
      'okay',
      'lgtm',
      'looks good',
      'continue',
      'keep going',
      'no issue',
      'no issues',
      'no problem',
      'all good',
      '계속',
      '계속하세요',
      '계속 진행',
      '문제 없음',
      '문제없음',
      '좋아요',
      '좋습니다',
      '확인',
      '이상 없음',
    ]) {
      expect(ADVICE_FILLER_PHRASES, phrase).toContain(phrase);
    }
  });

  it('does not call a real sentence noise because it contains a filler word', () => {
    for (const note of ['stop using the cache here', '계속 진행하기 전에 캐시 키를 확인하세요']) {
      expect(admit(emptyGuard(), { severity: 'nit', note }).outcome, note).toBe('admitted');
    }
  });

  it('treats empty and whitespace-only notes as noise', () => {
    for (const note of ['', '   ', '\n\t', '...', '***']) {
      expect(admit(emptyGuard(), { severity: 'blocker', note }).outcome, JSON.stringify(note)).toBe(
        'noise',
      );
    }
  });
});

describe('advice gatekeeper: duplicate', () => {
  it('suppresses the same note at the same or a lower severity', () => {
    const first = admit(emptyGuard(), {
      severity: 'concern',
      note: 'The cache key ignores the locale.',
    });
    expect(first.outcome).toBe('admitted');
    for (const [severity, note] of [
      ['concern', 'the cache key ignores the LOCALE'],
      ['nit', '  The cache key ignores the locale!!'],
    ] as const) {
      expect(admit(first.state, { severity, note }).outcome, `${severity} ${note}`).toBe(
        'duplicate',
      );
    }
  });

  it('passes the same note at a higher severity and then treats the lower one as a duplicate', () => {
    const nit = admit(emptyGuard(), { severity: 'nit', note: 'Rename the helper.' });
    expect(nit.outcome).toBe('admitted');
    const concern = admit(nit.state, { severity: 'concern', note: 'rename the helper' });
    expect(concern.outcome).toBe('admitted');
    expect(admit(concern.state, { severity: 'nit', note: 'rename the helper' }).outcome).toBe(
      'duplicate',
    );
    expect(admit(concern.state, { severity: 'concern', note: 'rename the helper' }).outcome).toBe(
      'duplicate',
    );
    expect(admit(concern.state, { severity: 'blocker', note: 'rename the helper' }).outcome).toBe(
      'admitted',
    );
  });

  it('checks noise before duplicate and duplicate before the budget', () => {
    let state = admitAll(emptyGuard(), ['one', 'two', 'three'], 'nit');
    // The budget is spent, so a new note is over budget but a repeat is a duplicate.
    expect(admit(state, { severity: 'nit', note: 'four' }).outcome).toBe('over_budget');
    expect(admit(state, { severity: 'nit', note: 'one' }).outcome).toBe('duplicate');
    expect(admit(state, { severity: 'nit', note: 'ok' }).outcome).toBe('noise');
    state = beginReview(state);
    expect(admit(state, { severity: 'nit', note: 'four' }).outcome).toBe('admitted');
  });
});

describe('advice gatekeeper: budget', () => {
  it('admits three non-blocker advice per review and refuses the fourth', () => {
    const state = admitAll(emptyGuard(), ['alpha', 'beta', 'gamma'], 'concern');
    const fourth = admit(state, { severity: 'nit', note: 'delta' });
    expect(fourth.outcome).toBe('over_budget');
    expect(admit(fourth.state, { severity: 'concern', note: 'epsilon' }).outcome).toBe(
      'over_budget',
    );
    expect(fourth.state.reviewCount).toBe(3);
  });

  it('never refuses a blocker for budget and does not count it', () => {
    let state = admitAll(emptyGuard(), ['b1', 'b2', 'b3', 'b4', 'b5'], 'blocker');
    expect(state.reviewCount).toBe(0);
    state = admitAll(state, ['n1', 'n2', 'n3'], 'nit');
    expect(admit(state, { severity: 'blocker', note: 'b6' }).outcome).toBe('admitted');
    expect(admit(state, { severity: 'nit', note: 'n4' }).outcome).toBe('over_budget');
  });

  it('counts a raised-severity repeat of a nit as a new non-blocker advice', () => {
    const state = admitAll(emptyGuard(), ['a', 'b'], 'nit');
    const raised = admit(state, { severity: 'concern', note: 'a' });
    expect(raised.outcome).toBe('admitted');
    expect(raised.state.reviewCount).toBe(3);
  });

  it('starts a new review with a fresh count and the same history', () => {
    const spent = admitAll(emptyGuard(), ['a', 'b', 'c'], 'nit');
    const next = beginReview(spent);
    expect(next.reviewCount).toBe(0);
    expect(next.history).toEqual(spent.history);
    expect(admit(next, { severity: 'nit', note: 'a' }).outcome).toBe('duplicate');
    expect(admit(next, { severity: 'nit', note: 'd' }).outcome).toBe('admitted');
  });
});

describe('advice gatekeeper: state', () => {
  it('leaves the state equal to the input when advice is suppressed', () => {
    const state = admitAll(emptyGuard(), ['a', 'b', 'c'], 'nit');
    for (const [severity, note, outcome] of [
      ['nit', 'ok', 'noise'],
      ['nit', 'a', 'duplicate'],
      ['nit', 'd', 'over_budget'],
    ] as const) {
      const result = admit(state, { severity, note });
      expect(result.outcome).toBe(outcome);
      expect(result.state).toEqual(state);
    }
  });

  it('does not mutate the input state', () => {
    const state = deepFreeze(admitAll(emptyGuard(), ['a'], 'nit'));
    const admitted = admit(state, { severity: 'concern', note: 'a' });
    expect(admitted.outcome).toBe('admitted');
    expect(admitted.state).not.toBe(state);
    expect(beginReview(state)).not.toBe(state);
    expect(admit(state, { severity: 'nit', note: 'b' }).state).not.toBe(state);
    expect(state.history).toEqual([{ key: 'a', severity: 'nit' }]);
    expect(state.reviewCount).toBe(1);
  });

  it('starts empty', () => {
    expect(emptyGuard()).toEqual({ history: [], reviewCount: 0 });
  });

  it('keeps the 512 most recent keys and forgets the oldest', () => {
    expect(ADVICE_HISTORY_LIMIT).toBe(512);
    let state = emptyGuard();
    for (let i = 0; i < 513; i++) {
      state = beginReview(admit(state, { severity: 'nit', note: `note ${i}` }).state);
    }
    expect(state.history).toHaveLength(512);
    expect(state.history[0]?.key).toBe('note 1');
    expect(state.history.at(-1)?.key).toBe('note 512');
    expect(admit(state, { severity: 'nit', note: 'note 0' }).outcome).toBe('admitted');
    expect(admit(state, { severity: 'nit', note: 'note 1' }).outcome).toBe('duplicate');
  });

  it('refreshes the position of a key admitted again at a higher severity', () => {
    let state = emptyGuard();
    for (let i = 0; i < 512; i++) {
      state = beginReview(admit(state, { severity: 'nit', note: `note ${i}` }).state);
    }
    state = beginReview(admit(state, { severity: 'concern', note: 'note 0' }).state);
    expect(state.history).toHaveLength(512);
    expect(state.history.at(-1)).toEqual({ key: 'note 0', severity: 'concern' });
    state = beginReview(admit(state, { severity: 'nit', note: 'a new one' }).state);
    // note 1 was the oldest after the refresh, so it is the one forgotten.
    expect(admit(state, { severity: 'nit', note: 'note 1' }).outcome).toBe('admitted');
    expect(admit(state, { severity: 'concern', note: 'note 0' }).outcome).toBe('duplicate');
  });
});
