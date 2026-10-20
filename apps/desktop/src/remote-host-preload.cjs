const { contextBridge, ipcRenderer } = require('electron');
const actions = new Set(['list', 'register', 'connect', 'disconnect', 'remove']);
contextBridge.exposeInMainWorld(
  'corralHosts',
  Object.freeze({
    request(action, value) {
      if (!actions.has(action)) return Promise.resolve({ error: 'Unknown host action.' });
      return ipcRenderer.invoke('desktop:remote-hosts', action, value);
    },
  }),
);
