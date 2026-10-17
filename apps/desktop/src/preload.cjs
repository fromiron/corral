const { contextBridge, ipcRenderer } = require('electron');

// No generic IPC, shell, filesystem, or event objects cross into the page. Menu commands
// arrive as plain names only (CR-017).
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
    revealWorkspace: () => ipcRenderer.invoke('desktop:reveal-workspace'),
    openExternal: (url) => ipcRenderer.invoke('desktop:external', url),
    retry: () => ipcRenderer.invoke('desktop:retry'),
    theme: (dark) => ipcRenderer.invoke('desktop:theme', dark === true),
    notify: (title, body) =>
      ipcRenderer.invoke('desktop:notify', { title: String(title), body: String(body) }),
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
