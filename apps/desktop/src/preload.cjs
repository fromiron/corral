const { contextBridge, ipcRenderer } = require('electron');

// No generic IPC, shell, filesystem, or event objects cross into the page.
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
  }),
);
