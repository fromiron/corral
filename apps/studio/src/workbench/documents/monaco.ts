export type Monaco = typeof import('monaco-editor/editor');

let loading: Promise<Monaco> | undefined;
const workerErrors = new Set<() => void>();

export function onMonacoWorkerError(listener: () => void): () => void {
  workerErrors.add(listener);
  return () => workerErrors.delete(listener);
}

/** Loading a file panel must not put the editor or language workers on chat's startup path. */
export function loadMonaco(): Promise<Monaco> {
  loading ??= Promise.all([
    import('monaco-editor/editor'),
    import('monaco-editor/editor/editor.worker?worker'),
    import('monaco-editor/features/register.all'),
    import('monaco-editor/languages/definitions/register.all'),
  ])
    .then(([monaco, { default: EditorWorker }]) => {
      self.MonacoEnvironment = {
        getWorker: () => {
          const worker = new EditorWorker();
          worker.addEventListener('error', () => {
            for (const listener of workerErrors) listener();
          });
          return worker;
        },
      };
      return monaco;
    })
    .catch((error) => {
      loading = undefined;
      throw error;
    });
  return loading;
}
