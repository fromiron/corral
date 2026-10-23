// Every pane a session's dock can show, defined once (#86): the URL `?panel=`, the dock, the
// command palette and the composer's `/` menu all read these lists, so a pane found in one is
// found in all of them under the same name.
export const DOCK_VIEWS = [
  'chat',
  'files',
  'changes',
  'git',
  'debug',
  'artifacts',
  'checks',
  'problems',
  'run',
  'terminal',
  'tools',
] as const;
export type DockView = (typeof DOCK_VIEWS)[number];

/** The conversation is the absence of `?panel=`; every other pane has a URL. */
export const SESSION_PANELS = [
  'changes',
  'git',
  'debug',
  'files',
  'artifacts',
  'checks',
  'problems',
  'run',
  'terminal',
  'tools',
] as const;
export type SessionPanel = (typeof SESSION_PANELS)[number];

/** What a person is doing when they open the pane; headings in pane lists (#70 IA-04/11). */
export type PaneGroup = 'develop' | 'verify' | 'run';
export interface PaneEntry {
  view: SessionPanel;
  group: PaneGroup;
  /** The composer's `/` name. */
  slash: string;
  /**
   * Other words people use for it, in every shipped language, so searching for what another
   * screen or an older label called it still finds it.
   */
  aliases: readonly string[];
}
export const PANE_CATALOG: readonly PaneEntry[] = [
  {
    view: 'files',
    group: 'develop',
    slash: 'files',
    aliases: ['files', 'explorer', 'documents', 'editor', '파일', '탐색기', '문서', '편집'],
  },
  {
    view: 'changes',
    group: 'develop',
    slash: 'changes',
    aliases: ['changes', 'diff', 'working copy', 'checkpoint', '변경', '사본', '체크포인트'],
  },
  {
    view: 'git',
    group: 'develop',
    slash: 'git',
    aliases: ['git', 'staged', 'unstaged', 'index', 'branch', '깃', '브랜치', '스테이징'],
  },
  {
    view: 'debug',
    group: 'develop',
    slash: 'debug',
    aliases: [
      'debug',
      'debugger',
      'breakpoint',
      'stack',
      '디버깅',
      '디버거',
      '중단점',
      '호출 스택',
    ],
  },
  {
    view: 'terminal',
    group: 'develop',
    slash: 'terminal',
    aliases: ['terminal', 'shell', 'console', 'pty', '터미널', '셸', '콘솔'],
  },
  {
    view: 'tools',
    group: 'develop',
    slash: 'preview',
    aliases: [
      'tools',
      'tasks',
      'scripts',
      'dev server',
      'commands',
      'running',
      'process',
      'preview',
      'service',
      'server',
      '도구',
      '작업',
      '스크립트',
      '명령',
      '실행 중',
      '프로세스',
      '미리보기',
      '서버',
    ],
  },
  {
    view: 'checks',
    group: 'verify',
    slash: 'checks',
    aliases: ['checks', 'verify', 'verification', 'tests', 'lint', '검사', '검증', '테스트'],
  },
  {
    view: 'problems',
    group: 'verify',
    slash: 'problems',
    aliases: ['problems', 'errors', 'warnings', 'diagnostics', '문제', '오류', '경고'],
  },
  {
    view: 'artifacts',
    group: 'verify',
    slash: 'results',
    aliases: ['results', 'artifacts', 'outputs', '결과', '산출물', '출력'],
  },
  {
    view: 'run',
    group: 'run',
    slash: 'run',
    aliases: ['run', 'execution', 'progress', '실행', '진행'],
  },
];

/** View references only; document, process and Run owners stay in their existing stores. */
export type PanelDescriptor =
  | {
      kind:
        | 'chat'
        | 'files'
        | 'changes'
        | 'git'
        | 'debug'
        | 'artifacts'
        | 'checks'
        | 'problems'
        | 'review';
      projectId: string;
      sessionId: string;
    }
  | { kind: 'graph'; projectId: string; corralId: string }
  | { kind: 'run'; runId: string }
  | { kind: 'file-preview'; sessionId: string; path: string }
  | { kind: 'service-preview'; sessionId: string }
  | { kind: 'terminal'; sessionId: string; terminalId: string };

const namespaces = new WeakMap<object, number>();
let nextNamespace = 0;

/** Renderer view identity only. Persistent layouts must use stable host/project identity. */
export function panelKey(services: object, panel: PanelDescriptor): string {
  let namespace = namespaces.get(services);
  if (namespace === undefined) {
    namespace = ++nextNamespace;
    namespaces.set(services, namespace);
  }
  const key = (...target: string[]) => JSON.stringify([namespace, panel.kind, ...target]);
  switch (panel.kind) {
    case 'chat':
    case 'files':
    case 'changes':
    case 'git':
    case 'debug':
    case 'artifacts':
    case 'checks':
    case 'problems':
    case 'review':
      return key(panel.projectId, panel.sessionId);
    case 'graph':
      return key(panel.projectId, panel.corralId);
    case 'run':
      return key(panel.runId);
    case 'file-preview':
      return key(panel.sessionId, panel.path);
    case 'service-preview':
      return key(panel.sessionId);
    case 'terminal':
      return key(panel.sessionId, panel.terminalId);
  }
}
