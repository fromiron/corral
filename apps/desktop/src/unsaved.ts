interface UnsavedWindow {
  isDestroyed(): boolean;
  webContents: {
    getURL(): string;
    executeJavaScript(code: string): Promise<unknown>;
  };
}

/** A WebContentsView's native parent can exist without ever loading a document. */
export async function hasWindowUnsavedEdits(windows: readonly UnsavedWindow[]): Promise<boolean> {
  for (const window of windows) {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      if (window.isDestroyed()) continue;
      const url = window.webContents.getURL();
      if (!url || url === 'about:blank') continue;
      const dirty = await Promise.race([
        window.webContents.executeJavaScript(`(() => {
          const event = new Event('beforeunload', { cancelable: true });
          window.dispatchEvent(event);
          return event.defaultPrevented;
        })()`),
        // A stuck renderer requires explicit discard on quit; it never authorizes an update.
        new Promise<boolean>((resolve) => {
          timeout = setTimeout(() => resolve(true), 2000);
        }),
      ]);
      if (dirty) return true;
    } catch {
      return true;
    } finally {
      clearTimeout(timeout);
    }
  }
  return false;
}
