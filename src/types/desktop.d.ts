interface Window {
  gitDigestDesktop?: {
    pickLocalPath(kind: 'file' | 'folder'): Promise<string | null>;
  };
}
