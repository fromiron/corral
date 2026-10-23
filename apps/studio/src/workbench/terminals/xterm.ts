import type { FitAddon } from '@xterm/addon-fit';
import type { Terminal } from '@xterm/xterm';
import { resolvedThemeColors } from '../theme-colors.ts';

export interface XtermRuntime {
  terminal: Terminal;
  fit: FitAddon;
  host: HTMLDivElement;
  dispose(): void;
}

/** The store owns the parser and DOM; mounting a pane only moves their container. */
export async function createXterm(
  container: HTMLElement,
  cols: number,
  rows: number,
  onData: (data: string) => void,
): Promise<XtermRuntime> {
  const [{ Terminal }, { FitAddon }] = await Promise.all([
    import('@xterm/xterm'),
    import('@xterm/addon-fit'),
    import('@xterm/xterm/css/xterm.css'),
  ]);
  const host = document.createElement('div');
  host.className = 'h-full min-h-64 w-full';
  container.append(host);
  const terminal = new Terminal({
    cols,
    rows,
    scrollback: 2000,
    fontSize: 14,
    screenReaderMode: true,
    cursorBlink: false,
    smoothScrollDuration: 0,
    minimumContrastRatio: 4.5,
    disableStdin: true,
    logLevel: 'off',
  });
  const fit = new FitAddon();
  terminal.loadAddon(fit);
  // Terminal output cannot read/write the clipboard or create clickable OSC links.
  terminal.parser.registerOscHandler(52, () => true);
  terminal.parser.registerOscHandler(8, () => true);
  terminal.open(host);
  const input = terminal.onData(onData);
  const theme = () => {
    const colors = resolvedThemeColors(['surface', 'text', 'primary']);
    terminal.options.theme = {
      background: colors.surface,
      foreground: colors.text,
      cursor: colors.primary,
      cursorAccent: colors.surface,
    };
  };
  theme();
  const observer = new MutationObserver(theme);
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['class', 'data-theme', 'style'],
  });
  return {
    terminal,
    fit,
    host,
    dispose() {
      input.dispose();
      observer.disconnect();
      terminal.dispose();
      host.remove();
    },
  };
}
