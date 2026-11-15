interface Window {
  gitDigestDesktop?: {
    pickLocalPath(kind: 'file' | 'folder'): Promise<string | null>;
    fetchApi?(path: string, options?: RequestInit): Promise<Response>;
  };
}
