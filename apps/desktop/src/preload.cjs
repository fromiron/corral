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
    // The session panel's browser tab (src/browser-bridge.ts has the shapes). Pages in it get
    // nothing of this: they have no preload.
    browser: Object.freeze({
      navigate: (tabId, projectId, address) =>
        ipcRenderer.invoke('desktop:browser-navigate', tabId, projectId, address),
      openPreview: (tabId, sessionId, leaseId) =>
        ipcRenderer.invoke('desktop:browser-open-preview', tabId, sessionId, leaseId),
      place: (tabId, rect) => ipcRenderer.invoke('desktop:browser-place', tabId, rect),
      close: (tabId) => ipcRenderer.invoke('desktop:browser-close', tabId),
      unload: (tabId) => ipcRenderer.invoke('desktop:browser-unload', tabId),
      reload: (tabId) => ipcRenderer.invoke('desktop:browser-reload', tabId),
      stop: (tabId) => ipcRenderer.invoke('desktop:browser-stop', tabId),
      back: (tabId) => ipcRenderer.invoke('desktop:browser-back', tabId),
      forward: (tabId) => ipcRenderer.invoke('desktop:browser-forward', tabId),
      reopen: (tabId) => ipcRenderer.invoke('desktop:browser-reopen', tabId),
      zoom: (tabId, zoom) => ipcRenderer.invoke('desktop:browser-zoom', tabId, zoom),
      focus: (tabId) => ipcRenderer.invoke('desktop:browser-focus', tabId),
      still: (tabId) => ipcRenderer.invoke('desktop:browser-still', tabId),
      freeze: (tabId, stillId) => ipcRenderer.invoke('desktop:browser-freeze', tabId, stillId),
      thaw: (tabId) => ipcRenderer.invoke('desktop:browser-thaw', tabId),
      answerPermission: (tabId, requestId, allow) =>
        ipcRenderer.invoke('desktop:browser-answer-permission', tabId, requestId, allow),
      sitePermissions: (projectId, origin) =>
        ipcRenderer.invoke('desktop:browser-site-permissions', projectId, origin),
      forgetPermission: (projectId, origin, permission) =>
        ipcRenderer.invoke('desktop:browser-forget-permission', projectId, origin, permission),
      answerLogin: (tabId, requestId, credentials) =>
        ipcRenderer.invoke('desktop:browser-answer-login', tabId, requestId, credentials),
      proceedCertificate: (tabId, challengeId) =>
        ipcRenderer.invoke('desktop:browser-proceed-certificate', tabId, challengeId),
      downloads: (tabId) => ipcRenderer.invoke('desktop:browser-downloads', tabId),
      cancelDownload: (downloadId) =>
        ipcRenderer.invoke('desktop:browser-cancel-download', downloadId),
      showDownload: (downloadId) => ipcRenderer.invoke('desktop:browser-show-download', downloadId),
      openBlocked: (tabId) => ipcRenderer.invoke('desktop:browser-open-blocked', tabId),
      clearProjectData: (projectId) =>
        ipcRenderer.invoke('desktop:browser-clear-project-data', projectId),
      removeProject: (projectId) => ipcRenderer.invoke('desktop:browser-remove-project', projectId),
      setShortcuts: (chords) => ipcRenderer.invoke('desktop:browser-set-shortcuts', chords),
      capturePreview: (tabId, options) =>
        ipcRenderer.invoke('desktop:browser-capture-preview', tabId, options),
      cancelPreviewCapture: (tabId) =>
        ipcRenderer.invoke('desktop:browser-cancel-preview-capture', tabId),
      onEvent: (callback) => {
        if (typeof callback !== 'function') return () => {};
        const listener = (_event, value) => {
          if (value && typeof value === 'object' && typeof value.type === 'string') callback(value);
        };
        ipcRenderer.on('desktop:browser-event', listener);
        return () => ipcRenderer.removeListener('desktop:browser-event', listener);
      },
    }),
  }),
);
