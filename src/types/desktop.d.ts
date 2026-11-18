interface Window {
  gitDigestDesktop?: {
    pickLocalPath(kind: 'file' | 'folder'): Promise<string | null>;
    readToken?(): Promise<string>;
    saveToken?(token: string): Promise<void>;
    openExternal?(url: string): Promise<void>;
    revealDownload?(path: string): Promise<void>;
    onDownload?(callback: (event: { success: boolean; path?: string | null }) => void): Promise<() => void>;
    fetchApi?(path: string, options?: RequestInit): Promise<Response>;
  };
}
