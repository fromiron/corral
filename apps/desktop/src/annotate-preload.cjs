const { contextBridge, ipcRenderer } = require('electron');

// The annotation overlay's only way out (src/annotate-bridge.ts has the shapes). Main checks every
// call again and knows which tab this overlay is over. No generic IPC or event objects cross in.
const waiting = [];
const listeners = new Set();
ipcRenderer.on('annotate:event', (_event, value) => {
  if (!value || typeof value !== 'object' || typeof value.type !== 'string') return;
  // Events before the overlay listens (its page, its context) wait for the first listener.
  if (listeners.size === 0) {
    if (waiting.length < 50) waiting.push(value);
    return;
  }
  for (const listener of listeners) listener(value);
});
contextBridge.exposeInMainWorld(
  'corralAnnotate',
  Object.freeze({
    frame: (input) => ipcRenderer.invoke('annotate:frame', input),
    pick: (at) => ipcRenderer.invoke('annotate:pick', at),
    walk: (direction) => ipcRenderer.invoke('annotate:walk', direction),
    wheel: (event) => {
      ipcRenderer.invoke('annotate:wheel', event).catch(() => {});
    },
    inspect: (pickId) => ipcRenderer.invoke('annotate:inspect', pickId),
    consoleFor: (pickId) => ipcRenderer.invoke('annotate:console-for', pickId),
    preview: (pickId, property, value) =>
      ipcRenderer.invoke('annotate:preview', pickId, property, value),
    release: (pickId) => ipcRenderer.invoke('annotate:release', pickId),
    submit: (note) => ipcRenderer.invoke('annotate:submit', note),
    cancelSubmit: (noteId) => ipcRenderer.invoke('annotate:cancel-submit', noteId),
    tell: (message) => ipcRenderer.invoke('annotate:tell', message),
    end: () => ipcRenderer.invoke('annotate:end'),
    ended: () => ipcRenderer.invoke('annotate:ended'),
    onEvent: (callback) => {
      if (typeof callback !== 'function') return () => {};
      const listener = (value) => callback(value);
      listeners.add(listener);
      for (const value of waiting.splice(0)) listener(value);
      return () => listeners.delete(listener);
    },
  }),
);
