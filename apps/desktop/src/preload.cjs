const { contextBridge, ipcRenderer } = require('electron');

// No generic IPC, shell, filesystem, or event objects cross into the page. Menu commands
// arrive as plain names only.
const COMMANDS = new Set([
  'palette',
  'help',
  'session.new',
  'view.sidebar',
  'view.panel',
  'settings',
  'composer.focus',
  'nav.back',
  'nav.forward',
]);
contextBridge.exposeInMainWorld(
  'corralDesktop',
  Object.freeze({
    info: () => ipcRenderer.invoke('desktop:info'),
    window: (action) => ipcRenderer.invoke('desktop:window', action),
    pickFolder: () => ipcRenderer.invoke('desktop:pick-folder'),
    openWorkspace: () => ipcRenderer.invoke('desktop:open-workspace'),
    shortcuts: (bindings) => ipcRenderer.invoke('desktop:shortcuts', bindings),
    openPreview: (sessionId, leaseId) =>
      ipcRenderer.invoke('desktop:open-preview', sessionId, leaseId),
    capturePreview: (sessionId, leaseId, options) =>
      ipcRenderer.invoke('desktop:capture-preview', sessionId, leaseId, options),
    cancelPreviewCapture: (sessionId, leaseId) =>
      ipcRenderer.invoke('desktop:cancel-preview-capture', sessionId, leaseId),
    revealWorkspace: () => ipcRenderer.invoke('desktop:reveal-workspace'),
    openExternal: (url) => ipcRenderer.invoke('desktop:external', url),
    retry: () => ipcRenderer.invoke('desktop:retry'),
    theme: (dark) => ipcRenderer.invoke('desktop:theme', dark === true),
    locale: (value) => ipcRenderer.invoke('desktop:locale', String(value)),
    notify: (title, body, target) =>
      ipcRenderer.invoke('desktop:notify', { title: String(title), body: String(body), target }),
    onNotification: (callback) => {
      if (typeof callback !== 'function') return () => {};
      const listener = (_event, target) => callback(target);
      ipcRenderer.on('desktop:notification', listener);
      return () => ipcRenderer.removeListener('desktop:notification', listener);
    },
    badge: (count) => ipcRenderer.invoke('desktop:badge', Number(count)),
    onCommand: (callback) => {
      if (typeof callback !== 'function') return () => {};
      const listener = (_event, id) => {
        if (typeof id === 'string' && COMMANDS.has(id)) callback(id);
      };
      ipcRenderer.on('desktop:command', listener);
      return () => ipcRenderer.removeListener('desktop:command', listener);
    },
  }),
);
