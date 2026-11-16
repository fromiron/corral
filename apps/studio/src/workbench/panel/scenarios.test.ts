// The acceptance scenarios of features/session-panel.md that need no screen, each named with its
// own words (Given / When / Then shortened). Focus, dimming, dialogs, kept input and tab names are
// checked by render-level tests.
import { describe, expect, it } from 'vitest';
import type { SessionSearch } from '../panels/routes.ts';
import { nextSearch } from './address.ts';
import {
  artifacts,
  context,
  ctx,
  enter,
  files,
  ids,
  narrow,
  panel,
  run,
  runLink,
  shape,
  statuses,
  steps,
  unlisted,
  way,
} from './fixtures.ts';
import {
  type PanelStorage,
  parsePanelMemory,
  readPanelMemory,
  rememberedPanel,
  serializePanelMemory,
  writePanelMemory,
} from './memory.ts';
import {
  conversationOperable,
  EMPTY_PANEL,
  type PanelEvent,
  type PanelState,
  panelOnScreen,
  reducePanel,
  toggleAvailable,
} from './model.ts';
import {
  headLosesControls,
  receiptsOnlyHead,
  runControlPlace,
  runTabHeadRun,
  stopCommandRoute,
} from './runControls.ts';
import { plusItems } from './tabs.ts';

const EMPTY = shape(EMPTY_PANEL);

describe('탭', () => {
  it('실행이 둘인 대화, 닫힘, 자리 있음 → 답 행의 "실행 #2" → 옆으로 열리고 "실행 #2" 하나가 선택된다', () => {
    const { state, history } = reducePanel(EMPTY_PANEL, runLink('run_2'), ctx());
    expect(state.presentation).toBe('beside');
    expect(ids(state)).toEqual([run('run_2')]);
    expect(state.selected).toBe('run:run_2');
    expect(history).toBe('push');
  });

  it('실행 #2 · 파일, 파일 선택 → "실행 #2"를 다시 누른다 → 실행 #2 선택, 탭 둘, 순서 그대로', () => {
    const before = panel({
      tabs: [run('run_2'), files],
      selected: 'files',
      presentation: 'beside',
    });
    const { state } = reducePanel(before, runLink('run_2'), ctx());
    expect(ids(state)).toEqual([run('run_2'), files]);
    expect(state.selected).toBe('run:run_2');
  });

  it('파일 · 실행 #1 · 실행 #2, 실행 #1 선택 → 실행 #1 탭을 닫는다 → 실행 #2가 선택된다', () => {
    const before = panel({
      tabs: [files, run('run_1'), run('run_2')],
      selected: 'run:run_1',
      presentation: 'beside',
    });
    expect(reducePanel(before, { type: 'close', key: 'run:run_1' }, ctx()).state.selected).toBe(
      'run:run_2',
    );
  });

  it('파일 · 실행 #1, 파일 선택 → 실행 #1 탭을 가운데 버튼으로 닫는다 → 실행 #1이 닫히고 선택은 그대로다', () => {
    const before = panel({
      tabs: [files, run('run_1')],
      selected: 'files',
      presentation: 'beside',
    });
    const { state } = reducePanel(before, { type: 'close', key: 'run:run_1' }, ctx());
    expect(ids(state)).toEqual([files]);
    expect(state.selected).toBe('files');
  });

  it('폴더 없고 실행 없는 대화에서 "Corral 설계 열기"로 파일 탭만 열었다 → 파일 탭을 닫는다 → 닫힘, 여닫기 버튼 없음', () => {
    const none = ctx({ folder: false, runIds: [] });
    const { state } = steps(
      EMPTY_PANEL,
      [way({ panel: 'files' }), { type: 'close', key: 'files' }],
      none,
    );
    expect(state.presentation).toBe('closed');
    expect(toggleAvailable(state, none)).toBe(false);
  });

  it('폴더 있고 실행 있는 대화, 파일 · 실행 #1 → Delete를 두 번 → 열린 채 파일 · 변경 · 실행 기록 · 결과 목록', () => {
    const before = panel({
      tabs: [files, run('run_1')],
      selected: 'files',
      presentation: 'beside',
    });
    const { state } = steps(before, [
      { type: 'close', key: 'files' },
      { type: 'close', key: 'run:run_1' },
    ]);
    expect(shape(state)).toEqual({ ...EMPTY, presentation: 'beside' });
    expect(plusItems(ctx())).toEqual(['files', 'changes', 'run-history', 'artifacts']);
  });

  it('실행 #1 탭 선택, 실행 #2 진행 중 → 실행 #2가 끝나고 실행 #3이 시작한다 → 탭 · 선택 · 상태가 바뀌지 않는다', () => {
    const before = panel({ tabs: [run('run_1')], selected: 'run:run_1', presentation: 'beside' });
    // No event exists for a run starting or ending; the run list growing changes nothing.
    const { state } = reducePanel(before, context, ctx({ runIds: ['run_1', 'run_2', 'run_3'] }));
    expect(state).toBe(before);
  });

  it('결과 탭이 열려 있다 → 실행 #1의 결과를 고른다 → 실행 #1 탭이 결과 보기에서 그 결과를 보이고 결과 탭은 남는다', () => {
    const before = panel({ tabs: [artifacts], selected: 'artifacts', presentation: 'beside' });
    const event = runLink('run_1');
    const result = reducePanel(before, event, ctx());
    expect(ids(result.state)).toEqual([artifacts, run('run_1')]);
    expect(result.state.selected).toBe('run:run_1');
    expect(result.history).toBe('push');
    // The way carries the result it points at as the tab's own state.
    expect(
      nextSearch({ panel: 'artifacts' }, result, { view: 'results', result: 'res_1' }),
    ).toEqual({ panel: 'run', run: 'run_1', view: 'results', result: 'res_1' });
  });

  it('열린 탭이 없고, 실행이 없으며, 폴더가 연결되지 않은 대화 → 여닫기 버튼과 "패널 여닫기"가 없다', () => {
    expect(toggleAvailable(EMPTY_PANEL, ctx({ folder: false, runIds: [] }))).toBe(false);
  });
});

describe('여는 길과 주소의 실행', () => {
  it('닫힘 → 이 대화에 없는 실행의 ?panel=run&run=… 주소로 들어오고 목록이 답한다 → 가장 새 실행의 탭, 주소 그 실행, 기록 없음', () => {
    const entered = reducePanel(
      EMPTY_PANEL,
      enter({ panel: 'run', run: 'run_x' }, null, 'address'),
      unlisted(),
    );
    const { state, address, history } = reducePanel(entered.state, context, ctx());
    expect(ids(state)).toEqual([run('run_2')]);
    expect(state.selected).toBe('run:run_2');
    expect(address).toEqual({ panel: 'run', run: 'run_2' });
    expect(history).toBe('replace');
  });

  it('방금 시작한 실행 #3을 가리키는 주소로 들어왔다 → 목록이 아직 답하지 않았다 → 탭은 실행 #3이고 실행 #2로 바뀌지 않는다', () => {
    const { state, address } = reducePanel(
      EMPTY_PANEL,
      enter({ panel: 'run', run: 'run_3' }, null, 'address'),
      unlisted(),
    );
    expect(ids(state)).toEqual([run('run_3')]);
    expect(address).toEqual({ panel: 'run', run: 'run_3' });
  });

  it('실행이 없는 대화 → ?panel=run 주소로 들어오고 실행 목록이 답한다 → 탭 없음, 닫힘, 주소 compose', () => {
    const entered = reducePanel(EMPTY_PANEL, enter({ panel: 'run' }, null, 'address'), unlisted());
    expect(entered.history).toBeNull();
    const { state, address, history } = reducePanel(entered.state, context, ctx({ runIds: [] }));
    expect(shape(state)).toEqual(EMPTY);
    expect(address).toEqual({ compose: true });
    expect(history).toBe('replace');
  });
});

describe('자리와 패널의 상태', () => {
  it('자리 없음, 닫힘 → "실행 #1"을 누른다 → 서랍으로 뜨고 대화는 조작을 받지 않는다', () => {
    const { state } = reducePanel(EMPTY_PANEL, runLink('run_1'), narrow());
    expect(state.presentation).toBe('drawer');
    expect(conversationOperable(state.presentation)).toBe(false);
  });

  it('"실행 #1"로 연 서랍 → Escape → 닫힘, 탭은 남고, 주소는 compose', () => {
    const { state, address, history } = steps(
      EMPTY_PANEL,
      [runLink('run_1'), { type: 'closeDrawer' }],
      narrow(),
    );
    expect(state.presentation).toBe('closed');
    expect(ids(state)).toEqual([run('run_1')]);
    expect(address).toEqual({ compose: true });
    expect(history).toBe('replace');
  });

  it('옆 → 창이 좁아져 자리가 없어진다 → 물러남, 주소는 panel 그대로, 버튼은 닫힌 상태', () => {
    const before = panel({ tabs: [files], selected: 'files', presentation: 'beside' });
    const { state, address } = reducePanel(before, context, narrow());
    expect(state.presentation).toBe('withdrawn');
    expect(address).toEqual({ panel: 'files' });
    expect(panelOnScreen(state.presentation)).toBe(false);
  });

  it('물러남 → 창이 넓어져 자리가 생긴다 → 옆', () => {
    const before = panel({ tabs: [files], selected: 'files', presentation: 'withdrawn' });
    expect(reducePanel(before, context, ctx()).state.presentation).toBe('beside');
  });

  it('물러남 → 여닫기 버튼 → 서랍으로 뜬다', () => {
    const before = panel({ tabs: [files], selected: 'files', presentation: 'withdrawn' });
    expect(reducePanel(before, { type: 'toggle' }, narrow()).state.presentation).toBe('drawer');
  });

  it('서랍 → 새로 고친다 → 물러남이고 서랍은 뜨지 않는다', () => {
    const drawer = reducePanel(EMPTY_PANEL, runLink('run_1'), narrow());
    const reloaded = reducePanel(
      EMPTY_PANEL,
      enter(drawer.address as SessionSearch, rememberedPanel(drawer.state), 'address'),
      narrow(),
    );
    expect(reloaded.state.presentation).toBe('withdrawn');
  });

  it('넓힘 → 창이 좁아져 자리가 없어진다 → 넓힘 그대로', () => {
    const before = panel({ tabs: [files], selected: 'files', presentation: 'maximized' });
    expect(reducePanel(before, context, narrow()).state.presentation).toBe('maximized');
  });

  it('자리가 없는 동안 넓힘 → 넓히기를 푼다 → 물러남', () => {
    const before = panel({ tabs: [files], selected: 'files', presentation: 'maximized' });
    expect(reducePanel(before, { type: 'maximize' }, narrow()).state.presentation).toBe(
      'withdrawn',
    );
  });

  it('실행 #1 탭 하나만 열린 패널이 넓힘 → 실행 #1 탭을 닫는다 → 넓히기가 풀리고 열린 채 목록', () => {
    const before = panel({
      tabs: [run('run_1')],
      selected: 'run:run_1',
      presentation: 'maximized',
    });
    const { state } = reducePanel(before, { type: 'close', key: 'run:run_1' }, ctx());
    expect(shape(state)).toEqual({ ...EMPTY, presentation: 'beside' });
  });

  it('자리가 없는 동안 실행 #1 탭 하나만 열린 패널이 넓힘 → 실행 #1 탭을 닫는다 → 닫힘, 주소 compose', () => {
    const before = panel({
      tabs: [run('run_1')],
      selected: 'run:run_1',
      presentation: 'maximized',
    });
    const { state, address } = reducePanel(before, { type: 'close', key: 'run:run_1' }, narrow());
    expect(shape(state)).toEqual(EMPTY);
    expect(address).toEqual({ compose: true });
  });

  it('자리 없음, 닫힘 → 확인 필요에서 이 대화의 ?panel=run&run=… 링크를 따라온다 → 서랍, 그 실행의 탭 선택', () => {
    const { state } = reducePanel(
      EMPTY_PANEL,
      enter({ panel: 'run', run: 'run_1' }, null, 'link'),
      narrow(),
    );
    expect(state.presentation).toBe('drawer');
    expect(state.selected).toBe('run:run_1');
  });
});

describe('실행 조작이 서는 곳', () => {
  const running = statuses({ run_1: 'running' });
  const beside = panel({ tabs: [run('run_1')], selected: 'run:run_1', presentation: 'beside' });
  const maximized = panel({
    tabs: [files, run('run_1')],
    selected: 'run:run_1',
    presentation: 'maximized',
  });
  const drawer = { ...maximized, presentation: 'drawer' as const };

  it('옆, 진행 중인 실행 #1의 탭 선택, receipt 하나가 기다린다 → 그 탭에는 조작과 receipt가 없고 컴포저 옆에만 있다', () => {
    expect(runControlPlace(beside, running)).toEqual({ at: 'composer' });
    expect(receiptsOnlyHead(beside, running)).toBeNull();
  });

  it('옆, 진행 중인 실행 #1 선택, 실행 단위 둘 → 컴포저의 중지 → 컴포저가 묻고 실행 #1 탭은 묻지 않는다', () => {
    expect(runTabHeadRun(beside)).toBeNull();
    expect(stopCommandRoute(beside, running, 'run_1')).toEqual({
      at: 'composer',
      bringForward: false,
    });
  });

  it('닫힘에서 "실행 #1"로 옆으로 열었고 컴포저가 묻는다 → 뒤로 → 닫힘, 컴포저의 확인 대기는 남는다', () => {
    const opened = reducePanel(EMPTY_PANEL, runLink('run_1'), ctx()).state;
    const back = reducePanel(opened, { type: 'history', search: { compose: true } }, ctx());
    expect(back.state.presentation).toBe('closed');
    expect(runControlPlace(opened, running)).toEqual({ at: 'composer' });
    expect(runControlPlace(back.state, running)).toEqual({ at: 'composer' });
    expect(back.dropHeadConfirmation).toBe(false);
  });

  it('넓힘, 실행 단위 하나가 일하는 진행 중인 실행 #1 선택 → 탭 머리의 중지 → 머리가 묻는다', () => {
    expect(runControlPlace(maximized, running)).toEqual({ at: 'run-tab', runId: 'run_1' });
  });

  it('넓힘, 실행 단위 하나가 일하는 진행 중인 실행 #1 선택 → 중지 단축키 → 탭 머리가 묻는다', () => {
    expect(stopCommandRoute(maximized, running, 'run_1')).toEqual({
      at: 'run-tab',
      runId: 'run_1',
    });
  });

  it('넓힘, 파일 탭 선택, 실행 #1 진행 중 → 중지 단축키 → 넓히기가 풀리고 컴포저가 묻는다', () => {
    const onFiles = { ...maximized, selected: 'files' as const };
    expect(stopCommandRoute(onFiles, running, 'run_1')).toEqual({
      at: 'composer',
      bringForward: true,
    });
    const forward = reducePanel(onFiles, { type: 'bringForward' }, ctx()).state;
    expect(forward.presentation).toBe('beside');
    expect(runControlPlace(forward, running)).toEqual({ at: 'composer' });
  });

  it('넓힘, 파일 · 실행 #1, 머리가 묻는다 → 파일 탭을 골랐다가 실행 #1로 돌아온다 → 확인 대기는 버려졌다', () => {
    const toFiles = reducePanel(maximized, { type: 'select', key: 'files' }, ctx());
    const back = reducePanel(toFiles.state, { type: 'select', key: 'run:run_1' }, ctx());
    expect(toFiles.dropHeadConfirmation).toBe(true);
    // Coming back regains the place but not the dropped confirmation (render-level).
    expect(back.dropHeadConfirmation).toBe(false);
  });

  it('넓힘, 머리가 묻는다 → 넓히기를 푼다 → 버려지고 컴포저도 묻지 않는다', () => {
    const released = reducePanel(maximized, { type: 'maximize' }, ctx());
    expect(released.dropHeadConfirmation).toBe(true);
    expect(runControlPlace(released.state, running)).toEqual({ at: 'composer' });
  });

  it('넓힘, 머리가 묻는다 → 실행 #1 탭을 닫는다 → 버려진다', () => {
    expect(
      reducePanel(maximized, { type: 'close', key: 'run:run_1' }, ctx()).dropHeadConfirmation,
    ).toBe(true);
  });

  it('넓힘, 머리가 묻는다 → 사이드바에서 다른 대화로 갔다가 돌아온다 → 버려졌다', () => {
    const memory = rememberedPanel(maximized);
    const elsewhere = reducePanel(maximized, enter({}, null), ctx());
    const returned = reducePanel(elsewhere.state, enter({}, memory), ctx()).state;
    expect(elsewhere.dropHeadConfirmation).toBe(true);
    expect(returned.presentation).toBe('beside');
  });

  it('닫힘에서 "실행 #1"로 열어 넓혔고 머리가 묻는다 → 뒤로 → compose, 닫힘, 버려진다', () => {
    const opened = steps(EMPTY_PANEL, [runLink('run_1'), { type: 'maximize' }]).state;
    const back = reducePanel(opened, { type: 'history', search: { compose: true } }, ctx());
    expect(back.state.presentation).toBe('closed');
    expect(back.address).toEqual({ compose: true });
    expect(back.dropHeadConfirmation).toBe(true);
  });

  it('넓힘, 실행 #1 안에서 실행 단위를 골라 기록이 쌓였고 머리가 묻는다 → 뒤로 → 같은 탭에서 넓힘, 확인 대기는 남는다', () => {
    const back = reducePanel(
      maximized,
      { type: 'history', search: { panel: 'run', run: 'run_1' } },
      ctx(),
    );
    expect(back.state.presentation).toBe('maximized');
    expect(back.state.selected).toBe('run:run_1');
    expect(back.dropHeadConfirmation).toBe(false);
  });

  it('서랍, 진행 중인 실행 #1 선택 → 머리에 일시정지 · 중지가 있고 컴포저는 조작을 받지 않는다', () => {
    expect(runControlPlace(drawer, running)).toEqual({ at: 'run-tab', runId: 'run_1' });
    expect(conversationOperable(drawer.presentation)).toBe(false);
  });

  it('서랍, 머리가 묻는다 → 서랍을 닫는다 → 버려진다', () => {
    expect(reducePanel(drawer, { type: 'closeDrawer' }, narrow()).dropHeadConfirmation).toBe(true);
  });

  it('서랍, 머리가 묻는다 → 창이 넓어져 자리가 생긴다 → 옆이 되고 버려진다', () => {
    const wider = reducePanel(drawer, context, ctx());
    expect(wider.state.presentation).toBe('beside');
    expect(wider.dropHeadConfirmation).toBe(true);
    expect(headLosesControls(drawer, wider.state)).toBe(true);
  });

  it('넓힘, 머리가 묻는다 → 실행 #1이 끝난다 → 머리에 조작이 없고 확인이 필요한 receipt만 남는다', () => {
    const finished = statuses({ run_1: 'succeeded' });
    expect(runControlPlace(maximized, finished)).toEqual({ at: 'nowhere' });
    expect(receiptsOnlyHead(maximized, finished)).toBe('run_1');
  });

  it('넓힘, 실행 #1이 지금 실행이고 머리가 묻는다 → 새로 고친다 → 넓힘이 아니고 컴포저가 조작을 가진다', () => {
    const reloaded = reducePanel(
      EMPTY_PANEL,
      enter({ panel: 'run', run: 'run_1' }, rememberedPanel(maximized), 'address'),
      ctx(),
    ).state;
    expect(reloaded.presentation).toBe('beside');
    expect(runControlPlace(reloaded, running)).toEqual({ at: 'composer' });
  });
});

describe('대화를 앞으로 가져오기', () => {
  const waiting = (presentation: PanelState['presentation']) =>
    panel({ tabs: [run('run_1')], selected: 'run:run_1', presentation });

  it('옆, 응답을 기다리는 실행 #1 선택 → 응답하기 → 패널, 선택, 주소의 panel이 그대로다', () => {
    const before = waiting('beside');
    const { state, address } = reducePanel(before, { type: 'bringForward' }, ctx());
    expect(state).toBe(before);
    expect(address).toEqual({ panel: 'run', run: 'run_1' });
  });

  it('넓힘, 응답을 기다리는 실행 #1 선택 → 머리의 응답하기 → 넓히기가 풀린다', () => {
    expect(
      reducePanel(waiting('maximized'), { type: 'bringForward' }, ctx()).state.presentation,
    ).toBe('beside');
  });

  it('서랍, 응답을 기다리는 실행 #1 선택 → 응답하기 → 서랍이 닫힌다', () => {
    expect(
      reducePanel(waiting('drawer'), { type: 'bringForward' }, narrow()).state.presentation,
    ).toBe('closed');
  });

  it('기억은 파일 탭이 선택된 열린 패널, 실행 #2가 기다린다 → 실행 #2의 respond 주소로 들어온다 → 파일 탭 선택, 실행 #2 탭 없음, 주소 panel=files, 기록 없음', () => {
    const search: SessionSearch = { panel: 'run', run: 'run_2', respond: true };
    const event = enter(search, { tabs: [files], selected: 'files', open: true });
    const result = reducePanel(EMPTY_PANEL, event, ctx());
    expect(ids(result.state)).toEqual([files]);
    expect(result.state.selected).toBe('files');
    expect(result.bringForward).toBe(true);
    expect(nextSearch(search, result)).toEqual({ panel: 'files' });
    expect(result.history).toBe('replace');
  });
});

describe('주소와 기억', () => {
  it('대화 A의 기억은 파일 · 실행 #1, 실행 #1 선택, 열림 → 사이드바에서 연다 → 옆, 이 순서, 실행 #1 선택', () => {
    const { state } = reducePanel(
      EMPTY_PANEL,
      enter({}, { tabs: [files, run('run_1')], selected: 'run:run_1', open: true }),
      ctx(),
    );
    expect(shape(state)).toEqual({
      tabs: [files, run('run_1')],
      selected: 'run:run_1',
      presentation: 'beside',
    });
  });

  it('자리 없음, 기억은 실행 #1 선택 열림 → 사이드바에서 연다 → 물러남, 서랍 없음, 주소 panel=run', () => {
    const { state, address } = reducePanel(
      EMPTY_PANEL,
      enter({}, { tabs: [run('run_1')], selected: 'run:run_1', open: true }),
      narrow(),
    );
    expect(state.presentation).toBe('withdrawn');
    expect(address).toEqual({ panel: 'run', run: 'run_1' });
  });

  it('기억은 파일 탭이 있는 열린 패널 → ?compose=true로 들어온다 → 닫힘, 파일 탭은 남는다', () => {
    const { state } = reducePanel(
      EMPTY_PANEL,
      enter({ compose: true }, { tabs: [files], selected: 'files', open: true }),
      ctx(),
    );
    expect(state.presentation).toBe('closed');
    expect(ids(state)).toEqual([files]);
  });

  it('여닫기로 열어 주소가 panel=files가 된 뒤 다른 화면으로 갔다 → 뒤로 가기로 돌아온다 → 열림, 파일 탭 선택', () => {
    const opened = reducePanel(
      panel({ tabs: [files], selected: 'files' }),
      { type: 'toggle' },
      ctx(),
    );
    expect(opened.address).toEqual({ panel: 'files' });
    expect(opened.history).toBe('replace');
    const back = reducePanel(
      EMPTY_PANEL,
      enter(opened.address as SessionSearch, rememberedPanel(opened.state), 'history'),
      ctx(),
    ).state;
    expect(back.presentation).toBe('beside');
    expect(back.selected).toBe('files');
  });

  it('"실행 #2"를 눌러 패널이 열렸다 → 뒤로 → 누르기 전의 compose, 닫힘, 되살리지 않는다', () => {
    const before = reducePanel(EMPTY_PANEL, enter({}, null), ctx());
    expect(before.address).toEqual({ compose: true });
    const opened = reducePanel(before.state, runLink('run_2'), ctx());
    expect(opened.history).toBe('push');
    const back = reducePanel(
      opened.state,
      { type: 'history', search: before.address as SessionSearch },
      ctx(),
    ).state;
    expect(back.presentation).toBe('closed');
    expect(ids(back)).toEqual([run('run_2')]);
  });

  it('다른 화면, 기억은 파일 탭이 있는 열린 패널 → message 주소로 들어온다 → 파일 탭 패널이 되살아난다', () => {
    const result = reducePanel(
      EMPTY_PANEL,
      enter({ message: 'msg_1' }, { tabs: [files], selected: 'files', open: true }),
      ctx(),
    );
    expect(result.state.presentation).toBe('beside');
    expect(result.state.selected).toBe('files');
    expect(result.bringForward).toBe(true);
  });

  it('대화 A 안에서 파일 탭이 선택된 패널이 넓힘 → 메시지 검색 결과에서 대화 A의 메시지를 고른다 → 넓히기가 풀리고 탭과 선택은 그대로', () => {
    const before = panel({ tabs: [files], selected: 'files', presentation: 'maximized' });
    const search: SessionSearch = { message: 'msg_1' };
    const event: PanelEvent = { type: 'follow', search, source: 'in-app' };
    const result = reducePanel(before, event, ctx());
    expect(result.state.presentation).toBe('beside');
    expect(ids(result.state)).toEqual([files]);
    expect(result.state.selected).toBe('files');
    expect(result.bringForward).toBe(true);
    expect(nextSearch(search, result)).toEqual({ panel: 'files', message: 'msg_1' });
    expect(result.history).toBe('replace');
  });

  it('대화 A 안에서 닫힘 → 인용에서 원문 메시지로 간다 → 주소에 message가 더해지고 닫힘 그대로', () => {
    const before = panel({ tabs: [files], selected: 'files', presentation: 'closed' });
    const search: SessionSearch = { compose: true, message: 'msg_1' };
    const event: PanelEvent = { type: 'follow', search, source: 'in-app' };
    const result = reducePanel(before, event, ctx());
    expect(result.state).toBe(before);
    expect(nextSearch(search, result)).toEqual({ compose: true, message: 'msg_1' });
  });

  it('"실행 #2"로 실행 #2를 열고 파일 링크로 파일을 연 뒤 탭 줄에서 실행 #2를 닫았다 → 뒤로 → 실행 #2가 오른쪽 끝에 다시 열리고 선택된다', () => {
    const opened = steps(EMPTY_PANEL, [
      runLink('run_2'),
      way({ panel: 'files' }),
      { type: 'close', key: 'run:run_2' },
    ]).state;
    expect(ids(opened)).toEqual([files]);
    const { state } = reducePanel(
      opened,
      { type: 'history', search: { panel: 'run', run: 'run_2' } },
      ctx(),
    );
    expect(ids(state)).toEqual([files, run('run_2')]);
    expect(state.selected).toBe('run:run_2');
  });

  it('기억은 탭 없이 열린 패널 → 사이드바에서 연다 → 닫힘', () => {
    const { state } = reducePanel(
      EMPTY_PANEL,
      enter({}, { tabs: [], selected: null, open: true }),
      ctx(),
    );
    expect(state.presentation).toBe('closed');
  });

  it('대화 A에 탭이 있고, 같은 프로젝트의 대화 B에는 기억이 없다 → 대화 B를 연다 → 탭 없이 닫힘', () => {
    const a = panel({ tabs: [files], selected: 'files', presentation: 'beside' });
    expect(shape(reducePanel(a, enter({}, null), ctx()).state)).toEqual(EMPTY);
  });

  it('대화의 기억을 읽을 수 없다 → 사이드바에서 연다 → 탭 없이 닫힘', () => {
    const unreadable: PanelStorage = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => undefined,
      removeItem: () => undefined,
    };
    const memory = readPanelMemory(unreadable, 'session_a');
    expect(shape(reducePanel(EMPTY_PANEL, enter({}, memory), ctx()).state)).toEqual(EMPTY);
  });

  it('기억은 파일 · 실행 #9, 실행 #9 선택, 실행 #9는 없다 → 사이드바에서 열고 목록이 답한다 → 실행 #9가 버려지고 파일 선택, 기록 없음', () => {
    const entered = reducePanel(
      EMPTY_PANEL,
      enter({}, { tabs: [files, run('run_9')], selected: 'run:run_9', open: true }),
      unlisted(),
    );
    const { state, history } = reducePanel(entered.state, context, ctx());
    expect(ids(state)).toEqual([files]);
    expect(state.selected).toBe('files');
    expect(history).toBe('replace');
  });

  it('파일 · 실행 #1, 실행 #1 선택 → 기억을 읽는다 → 종류, 실행 ID, 순서, 선택, 열림 여부만 있다', () => {
    const state = panel({
      tabs: [files, run('run_1')],
      selected: 'run:run_1',
      presentation: 'beside',
    });
    const raw = serializePanelMemory(rememberedPanel(state));
    expect(JSON.parse(raw)).toEqual({
      v: 1,
      tabs: ['files', 'run:run_1'],
      selected: 'run:run_1',
      open: true,
    });
    expect(parsePanelMemory(raw)).toEqual({
      tabs: [files, run('run_1')],
      selected: 'run:run_1',
      open: true,
    });
  });

  it('이 기기에 기억을 쓸 수 없다 → 탭을 열고 고르고 닫는다 → 화면은 알림 없이 그대로 동작한다', () => {
    const full: PanelStorage = {
      getItem: () => null,
      setItem: () => {
        throw new Error('quota');
      },
      removeItem: () => undefined,
    };
    let state: PanelState = EMPTY_PANEL;
    for (const event of [
      way({ panel: 'files' }),
      runLink('run_1'),
      { type: 'select', key: 'files' },
      { type: 'close', key: 'run:run_1' },
    ] satisfies PanelEvent[]) {
      state = reducePanel(state, event, ctx()).state;
      expect(() => writePanelMemory(full, 'session_a', state)).not.toThrow();
    }
    expect(shape(state)).toEqual({ tabs: [files], selected: 'files', presentation: 'beside' });
  });
});
