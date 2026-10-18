import type { ExtensionUiNotice, ExtensionUiRequest, ExtensionUiResult } from '@corral/contracts';
import type { ExtensionUIContext, ExtensionUIDialogOptions } from '@earendil-works/pi-coding-agent';

/** Keep Pi's harmless theme/read access; every supported interaction is owned by Corral. */
export function extensionUi(
  base: ExtensionUIContext,
  request: (request: ExtensionUiRequest, signal?: AbortSignal) => Promise<ExtensionUiResult>,
  notify: (notice: ExtensionUiNotice) => void,
): ExtensionUIContext {
  const timeout = (opts?: ExtensionUIDialogOptions) =>
    Math.min(300000, Math.max(1, opts?.timeout ?? 120000));
  const reported = new Set<string>();
  const unsupported = (name: string) => {
    if (reported.has(name)) return;
    reported.add(name);
    notify({
      kind: 'unsupported',
      key: name,
      text: `Pi UI ${name} is not supported in Corral.`,
      level: 'warning',
    });
  };
  return {
    ...base,
    select: async (title, options, opts) => {
      const result = await request(
        { kind: 'select', title, options, timeoutMs: timeout(opts) },
        opts?.signal,
      );
      return result.status === 'answered' && typeof result.value === 'string'
        ? result.value
        : undefined;
    },
    confirm: async (title, message, opts) => {
      const result = await request(
        { kind: 'confirm', title, message, timeoutMs: timeout(opts) },
        opts?.signal,
      );
      return result.status === 'answered' && result.value === true;
    },
    input: async (title, placeholder = '', opts) => {
      const result = await request(
        { kind: 'input', title, placeholder, timeoutMs: timeout(opts) },
        opts?.signal,
      );
      return result.status === 'answered' && typeof result.value === 'string'
        ? result.value
        : undefined;
    },
    notify: (text, level = 'info') => notify({ kind: 'notify', key: 'notification', text, level }),
    setStatus: (key, text) => notify({ kind: 'status', key, text: text ?? '', level: 'info' }),
    onTerminalInput: () => {
      unsupported('onTerminalInput');
      return () => {};
    },
    custom: async () => {
      unsupported('custom');
      throw new Error('custom terminal UI is unsupported');
    },
    editor: async () => {
      unsupported('editor');
      return undefined;
    },
    setWidget: () => unsupported('setWidget'),
    setFooter: () => unsupported('setFooter'),
    setHeader: () => unsupported('setHeader'),
    setTitle: () => unsupported('setTitle'),
    setWorkingMessage: () => unsupported('setWorkingMessage'),
    setWorkingVisible: () => unsupported('setWorkingVisible'),
    setWorkingIndicator: () => unsupported('setWorkingIndicator'),
    setHiddenThinkingLabel: () => unsupported('setHiddenThinkingLabel'),
    pasteToEditor: () => unsupported('pasteToEditor'),
    setEditorText: () => unsupported('setEditorText'),
    addAutocompleteProvider: () => unsupported('addAutocompleteProvider'),
    setEditorComponent: () => unsupported('setEditorComponent'),
    setToolsExpanded: () => unsupported('setToolsExpanded'),
    setTheme: () => {
      unsupported('setTheme');
      return { success: false, error: 'terminal themes are unsupported' };
    },
  };
}
