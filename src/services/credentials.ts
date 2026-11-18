let token = '';
const legacyKey = 'gitingest_custom_pat';

export async function initializeCredentials(): Promise<void> {
  const desktop = window.gitDigestDesktop;
  let legacy = '';
  try {
    legacy = localStorage.getItem(legacyKey) || '';
    localStorage.removeItem('gitingest_auth_cache');
  } catch {}
  if (desktop?.readToken && desktop.saveToken) {
    token = await desktop.readToken();
    if (!token && legacy) {
      await desktop.saveToken(legacy);
      token = legacy;
    }
  } else {
    // Browser credentials last only until the page is closed or refreshed.
    token = legacy;
  }
  try { localStorage.removeItem(legacyKey); } catch {}
}

export function getCredential(): string { return token; }

export async function saveCredential(value: string): Promise<void> {
  const clean = value.trim();
  await window.gitDigestDesktop?.saveToken?.(clean);
  token = clean;
  try { localStorage.removeItem(legacyKey); } catch {}
}
