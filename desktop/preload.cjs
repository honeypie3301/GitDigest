const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('gitDigestDesktop', {
  readToken: () => ipcRenderer.invoke('read-token'),
  saveToken: (token) => ipcRenderer.invoke('save-token', token),
  openExternal: (url) => ipcRenderer.invoke('open-external', url),
  revealDownload: (path) => ipcRenderer.invoke('reveal-download', path),
  onDownload: async (callback) => {
    const listener = (_event, data) => callback(data);
    ipcRenderer.on('download-finished', listener);
    return () => ipcRenderer.removeListener('download-finished', listener);
  },
  pickLocalPath: (kind) => ipcRenderer.invoke('pick-local-path', kind),
});
