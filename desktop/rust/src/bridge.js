if (window === window.top && window.location.origin === 'http://tauri.localhost') {
  const endpoint = __API_ENDPOINT__;
  const key = __API_KEY__;
  window.gitDigestDesktop = {
    onDownload: (callback) => window.__TAURI__.event.listen('download-finished', (event) => callback(event.payload)),
    readToken: () => window.__TAURI__.core.invoke('read_token'),
    saveToken: (token) => window.__TAURI__.core.invoke('save_token', { token }),
    openExternal: (url) => window.__TAURI__.core.invoke('open_external', { url }),
    revealDownload: (path) => window.__TAURI__.core.invoke('reveal_download', { path }),
    pickLocalPath: (kind) => window.__TAURI__.core.invoke('pick_local_path', { kind }),
    fetchApi: (path, options) => {
      const headers = new Headers(options?.headers);
      headers.set('X-GitDigest-Desktop', key);
      return fetch(endpoint + path, { ...options, headers });
    },
  };
}
