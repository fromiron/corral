const { contextBridge, ipcRenderer } = require('electron');
const hostId = process.argv.find((value) => value.startsWith('--corral-host-id='))?.slice(17);
if (/^host_[0-9a-f-]{36}$/.test(hostId ?? ''))
  contextBridge.exposeInMainWorld(
    'corralRemote',
    Object.freeze({
      hostId,
      openPreview: (sessionId, leaseId) =>
        ipcRenderer.invoke('desktop:remote-preview', sessionId, leaseId),
    }),
  );
