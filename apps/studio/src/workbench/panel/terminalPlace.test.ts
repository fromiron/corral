import { describe, expect, it } from 'vitest';
import {
  addressedTerminalPlace,
  plusTerminalPlace,
  type TerminalListAnswer,
} from './terminalPlace.ts';

// Where a terminal opens (features/session-panel.md 여는 길, 주소와 기억, "+" 목록): a terminal's
// tab is in the panel or in the bottom dock, never both, and no way moves it to the other strip.

const waiting: TerminalListAnswer = { kind: 'waiting' };
const failed: TerminalListAnswer = { kind: 'failed' };
const listed = (ids: string[], live: string | null = null): TerminalListAnswer => ({
  kind: 'answered',
  ids,
  live,
});
const strips = (panel: string[] = [], dock: string[] = []) => ({
  panel: new Set(panel),
  dock: new Set(dock),
});

describe('an address with panel=terminal and its terminal', () => {
  it('opens where its tab is, in the panel first, without waiting for the list', () => {
    expect(addressedTerminalPlace('term_1', strips(['term_1']), waiting, false)).toEqual({
      place: 'panel',
      terminalId: 'term_1',
    });
    expect(addressedTerminalPlace('term_1', strips([], ['term_1']), waiting, false)).toEqual({
      place: 'dock',
      terminalId: 'term_1',
    });
  });

  it('with no tab anywhere, waits for the list, then opens it in the dock if the list holds it', () => {
    expect(addressedTerminalPlace('term_1', strips(), waiting, false)).toEqual({ place: 'wait' });
    expect(addressedTerminalPlace('term_1', strips(), listed(['term_1']), false)).toEqual({
      place: 'dock',
      terminalId: 'term_1',
    });
  });

  it('opens nothing when the list does not hold it', () => {
    expect(addressedTerminalPlace('term_9', strips(), listed(['term_1'], 'term_1'), true)).toEqual({
      place: 'none',
    });
  });

  it('opens its tab in the dock as addressed when the list cannot be read', () => {
    expect(addressedTerminalPlace('term_1', strips(), failed, false)).toEqual({
      place: 'dock',
      terminalId: 'term_1',
    });
  });
});

describe('an address with panel=terminal and no terminal', () => {
  it('decides nothing until the list answers, even with a tab open', () => {
    expect(addressedTerminalPlace(undefined, strips(['term_1']), waiting, true)).toEqual({
      place: 'wait',
    });
  });

  it("selects the live terminal's tab where it is, and never moves it", () => {
    const answer = listed(['term_1'], 'term_1');
    expect(addressedTerminalPlace(undefined, strips(['term_1']), answer, true)).toEqual({
      place: 'panel',
      terminalId: 'term_1',
    });
    expect(addressedTerminalPlace(undefined, strips([], ['term_1']), answer, true)).toEqual({
      place: 'dock',
      terminalId: 'term_1',
    });
  });

  it("opens the live terminal's tab in the dock when it has none", () => {
    expect(addressedTerminalPlace(undefined, strips(), listed(['term_1'], 'term_1'), true)).toEqual(
      {
        place: 'dock',
        terminalId: 'term_1',
      },
    );
  });

  it('makes one in the dock with the default shell when none is live and one can be made', () => {
    expect(addressedTerminalPlace(undefined, strips(), listed(['term_0']), true)).toEqual({
      place: 'create',
    });
  });

  it('only opens the dock when none can be made, or when the list cannot be read', () => {
    expect(addressedTerminalPlace(undefined, strips(), listed([]), false)).toEqual({
      place: 'dockOnly',
    });
    expect(addressedTerminalPlace(undefined, strips(), failed, true)).toEqual({
      place: 'dockOnly',
    });
  });
});

describe('"+" → 터미널, from either strip', () => {
  it("selects the live terminal's tab where it is, wherever the list was opened", () => {
    for (const from of ['panel', 'dock'] as const) {
      expect(plusTerminalPlace(from, 'term_1', strips(['term_1']), true)).toEqual({
        place: 'panel',
        terminalId: 'term_1',
      });
      expect(plusTerminalPlace(from, 'term_1', strips([], ['term_1']), true)).toEqual({
        place: 'dock',
        terminalId: 'term_1',
      });
    }
  });

  it("opens the live terminal's tab in the strip of the list when it has none", () => {
    expect(plusTerminalPlace('panel', 'term_1', strips(), false)).toEqual({
      place: 'panel',
      terminalId: 'term_1',
    });
    expect(plusTerminalPlace('dock', 'term_1', strips(), false)).toEqual({
      place: 'dock',
      terminalId: 'term_1',
    });
  });

  it('makes a new one for the strip of the list only when none is live, and nothing when it cannot', () => {
    expect(plusTerminalPlace('panel', null, strips(), true)).toEqual({
      place: 'create',
      strip: 'panel',
    });
    expect(plusTerminalPlace('dock', null, strips(), true)).toEqual({
      place: 'create',
      strip: 'dock',
    });
    expect(plusTerminalPlace('panel', null, strips(), false)).toEqual({ place: 'none' });
  });
});
