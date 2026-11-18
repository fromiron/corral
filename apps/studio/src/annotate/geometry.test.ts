import { describe, expect, it } from 'vitest';
import {
  framePath,
  markerPlaces,
  notePlace,
  noteWidth,
  outlineRect,
  stylePlace,
  tagPlace,
} from './geometry.ts';

// The overlay's places (features/browser-annotate.md 가리키기, 주석 칸, 번호 표시), in the
// overlay's CSS pixels from the page area's top left.

const area = { width: 1000, height: 700 };

describe('가리킴 테두리와 이름표', () => {
  it('테두리는 요소의 테두리 상자에서 3px 바깥의 2px 선이다', () => {
    // The line's inner edge is 3px out, its outer edge 5px.
    expect(outlineRect({ x: 100, y: 50, width: 120, height: 32 })).toEqual({
      x: 95,
      y: 45,
      width: 130,
      height: 42,
    });
  });

  it('이름표는 테두리 위 왼쪽, 위에 자리가 없으면 아래 왼쪽, 그것도 없으면 안의 위 왼쪽이다', () => {
    const tag = { width: 110, height: 18 };
    expect(tagPlace({ x: 95, y: 45, width: 130, height: 42 }, tag, area)).toEqual({
      x: 95,
      y: 23,
      at: 'above',
    });
    // Counterexample: a tag drawn above a box at the top would be cut off.
    expect(tagPlace({ x: 95, y: 10, width: 130, height: 42 }, tag, area)).toEqual({
      x: 95,
      y: 56,
      at: 'below',
    });
    expect(tagPlace({ x: -5, y: -5, width: 1010, height: 710 }, tag, area)).toEqual({
      x: 4,
      y: 4,
      at: 'inside',
    });
  });

  it('이름표는 페이지 자리의 옆 끝을 넘지 않는다', () => {
    const tag = { width: 110, height: 18 };
    expect(tagPlace({ x: 950, y: 300, width: 60, height: 20 }, tag, area).x).toBe(890);
    expect(tagPlace({ x: -40, y: 300, width: 60, height: 20 }, tag, area).x).toBe(0);
  });
});

describe('주석 칸의 폭과 자리', () => {
  it('폭은 320px과 (페이지 자리의 폭 − 16px) 가운데 작은 쪽이다', () => {
    expect(noteWidth(1000)).toBe(320);
    expect(noteWidth(300)).toBe(284);
  });

  const card = { width: 320, height: 160 };

  it('요소의 오른쪽에 12px 띄우고, 위아래는 페이지 자리의 가장자리와 8px을 띄운다', () => {
    expect(notePlace({ x: 100, y: 200, width: 200, height: 40 }, card, area)).toEqual({
      x: 312,
      y: 200,
      width: 320,
      side: 'right',
    });
    expect(notePlace({ x: 100, y: 650, width: 200, height: 40 }, card, area).y).toBe(532);
    expect(notePlace({ x: 100, y: -300, width: 200, height: 40 }, card, area).y).toBe(8);
  });

  it('오른쪽에 자리가 없으면 왼쪽, 아래, 위 순서다', () => {
    expect(notePlace({ x: 600, y: 200, width: 200, height: 40 }, card, area)).toMatchObject({
      x: 268,
      side: 'left',
    });
    // Counterexample: a wide element leaves neither side; the note goes under it.
    expect(notePlace({ x: 200, y: 100, width: 600, height: 40 }, card, area)).toEqual({
      x: 200,
      y: 152,
      width: 320,
      side: 'below',
    });
    expect(notePlace({ x: 200, y: 400, width: 600, height: 280 }, card, area)).toEqual({
      x: 200,
      y: 228,
      width: 320,
      side: 'above',
    });
    expect(notePlace({ x: -100, y: 100, width: 1050, height: 40 }, card, area).x).toBe(8);
  });

  it('어디에도 자리가 없으면 페이지 자리 안의 오른쪽에 요소와 겹쳐 선다', () => {
    expect(notePlace({ x: 0, y: 0, width: 1000, height: 700 }, card, area)).toEqual({
      x: 672,
      y: 8,
      width: 320,
      side: 'over',
    });
  });

  it('페이지 자리의 폭이 560px보다 좁으면 아래 끝에 양옆 8px을 두고 붙는다', () => {
    const narrow = { width: 500, height: 700 };
    expect(notePlace({ x: 10, y: 10, width: 50, height: 20 }, card, narrow)).toEqual({
      x: 8,
      y: 532,
      width: 484,
      side: 'docked',
    });
    expect(
      notePlace({ x: 10, y: 10, width: 50, height: 20 }, card, { width: 560, height: 700 }),
    ).toMatchObject({ side: 'right' });
  });
});

describe('번호 표시', () => {
  const box = (x: number, y: number) => ({ x, y, width: 100, height: 40 });

  it('요소의 오른쪽 위 모서리에 지름 18px의 원으로 선다', () => {
    expect(markerPlaces([{ pickId: 'a', n: 1, box: box(100, 100) }], area)).toEqual([
      { pickId: 'a', n: 1, x: 191, y: 91 },
    ]);
  });

  it('겹치면 22px씩 왼쪽으로 비켜 선다', () => {
    expect(
      markerPlaces(
        [
          { pickId: 'a', n: 1, box: box(100, 100) },
          { pickId: 'b', n: 2, box: box(100, 100) },
          { pickId: 'c', n: 3, box: box(102, 104) },
        ],
        area,
      ).map(({ n, x, y }) => [n, x, y]),
    ).toEqual([
      [1, 191, 91],
      [2, 169, 91],
      [3, 149, 95],
    ]);
  });

  it('늘 페이지의 스크롤 영역 안에, 테두리와 스크롤바에서 비켜 있다', () => {
    expect(
      markerPlaces([{ pickId: 'a', n: 1, box: { x: 950, y: -20, width: 100, height: 40 } }], area),
    ).toEqual([{ pickId: 'a', n: 1, x: 979, y: 3 }]);
    // Counterexample: a 15px page scrollbar; the scroll area is narrower than the page area.
    expect(
      markerPlaces([{ pickId: 'a', n: 1, box: { x: 950, y: 100, width: 100, height: 40 } }], {
        width: 985,
        height: 700,
      })[0]?.x,
    ).toBe(964);
  });

  it('페이지가 답하지 않는다는 줄에서 비켜 그 아래에 선다', () => {
    const line = { x: 400, y: 8, width: 200, height: 32 };
    expect(
      markerPlaces(
        [{ pickId: 'a', n: 1, box: { x: 450, y: 10, width: 100, height: 40 } }],
        area,
        line,
      ),
    ).toEqual([{ pickId: 'a', n: 1, x: 541, y: 44 }]);
    expect(markerPlaces([{ pickId: 'a', n: 1, box: box(100, 100) }], area, line)[0]?.y).toBe(91);
  });
});

describe('페이지 자리의 테두리', () => {
  it('주석 버튼에 가까운 오른쪽 위 모서리에서 출발해 페이지 자리를 한 바퀴 돈다', () => {
    // The 2px line sits inside the edge: its middle is 1px in.
    expect(framePath({ width: 400, height: 300 })).toBe('M 399 1 H 1 V 299 H 399 Z');
  });
});

describe('스타일 보기의 자리', () => {
  const note = { x: 312, y: 200, width: 320, height: 160 };

  it('폭 340px, 높이 480px까지의 떠 있는 보기로 주석 칸 옆의 자리가 있는 쪽에 선다', () => {
    expect(stylePlace(note, area)).toEqual({
      x: 640,
      y: 200,
      width: 340,
      height: 480,
      sheet: false,
    });
    // No room right of the note: left of it.
    expect(stylePlace({ ...note, x: 600 }, area)).toMatchObject({ x: 252, sheet: false });
    // A short page area: as tall as fits, inside it.
    expect(stylePlace(note, { width: 1000, height: 400 })).toMatchObject({ y: 8, height: 384 });
  });

  it('어느 쪽에도 자리가 없으면 자리가 더 넓은 쪽에 페이지 자리 안으로 선다', () => {
    expect(stylePlace({ ...note, x: 100 }, { width: 700, height: 700 })).toMatchObject({
      x: 352,
    });
  });

  it('페이지 자리의 폭이 560px보다 좁으면 높이 45%의 아래 시트이고 주석 칸은 그 위에 붙는다', () => {
    const narrow = { width: 500, height: 700 };
    expect(stylePlace(note, narrow)).toEqual({
      x: 0,
      y: 385,
      width: 500,
      height: 315,
      sheet: true,
    });
    expect(
      notePlace({ x: 10, y: 10, width: 50, height: 20 }, { width: 484, height: 160 }, narrow, 315),
    ).toEqual({ x: 8, y: 217, width: 484, side: 'docked' });
  });
});
