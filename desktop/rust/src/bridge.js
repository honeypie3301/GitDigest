if (window === window.top && window.location.origin === 'http://tauri.localhost') {
  const endpoint = __API_ENDPOINT__;
  const key = __API_KEY__;
  window.gitDigestDesktop = {
    pickLocalPath: (kind) => window.__TAURI__.core.invoke('pick_local_path', { kind }),
    fetchApi: (path, options) => {
      const headers = new Headers(options?.headers);
      headers.set('X-GitDigest-Desktop', key);
      return fetch(endpoint + path, { ...options, headers });
    },
  };
}
