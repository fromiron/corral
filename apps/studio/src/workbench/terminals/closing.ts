// What closing a terminal's tab does (features/session-panel.md 터미널 탭). Closing a tab ends its
// terminal; how depends on the terminal's state, and for a running one on its foreground read
// afresh at the moment of closing (a value held from before may predate the command now running).
import type { TerminalForeground, TerminalView } from '@corral/contracts';

/**
 * `end`: the explicit stop, without asking. `ask`: the dialog first; nothing is sent until it is
 * answered. `recheck`: the explicit stop as a renewed check of an unconfirmed end. `close`: the
 * tab goes and nothing is sent.
 */
export type ClosingAction = 'end' | 'ask' | 'recheck' | 'close';

export async function closingTerminal(
  state: TerminalView['state'],
  readForeground: () => Promise<TerminalForeground>,
): Promise<ClosingAction> {
  switch (state) {
    // The shell takes no input yet, so nothing typed can be running.
    case 'starting':
      return 'end';
    case 'running': {
      let foreground: TerminalForeground = 'unknown';
      try {
        foreground = await readForeground();
      } catch {}
      return foreground === 'idle' ? 'end' : 'ask';
    }
    case 'uncertain':
      return 'recheck';
    default:
      return 'close';
  }
}
