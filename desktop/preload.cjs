const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('gitDigestDesktop', {
  pickLocalPath: (kind) => ipcRenderer.invoke('pick-local-path', kind),
});
