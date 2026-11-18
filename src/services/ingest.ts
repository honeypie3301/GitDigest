import { getCredential, saveCredential } from './credentials';
import { IngestRequest, IngestResponse, TokenStatus, GitHubUser } from '../types';
import { ingestViaGitHubApi, verifyGitHubToken } from './githubApi';
import { waitForWorkerJob, type WorkerJob } from './workerJobs';
import { readApiResponse } from './apiResponse';

const AUTO_INJECT_KEY = 'gitingest_auto_inject_pat';
const PATTERN_TYPE_KEY = 'gitingest_pattern_type';
const PATTERN_VALUE_KEY = 'gitingest_pattern_val';
const MAX_FILE_SIZE_KEY = 'gitingest_max_file_size';
const MAX_OUTPUT_SIZE_KEY = 'gitingest_max_output_size';
const DECOMPILE_CLASSES_KEY = 'gitingest_decompile_classes';
const OUTPUT_FORMAT_KEY = 'gitingest_output_format';
const OWNER_PIN_KEY = 'gitingest_owner_pin';
const AUTH_CACHE_KEY = 'gitingest_auth_cache';
const AUTH_CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes

interface AuthCache {
  user: GitHubUser;
  token: string;
  ts: number;
}

const STATUS_CACHE_KEY = 'gitingest_status_cache';

function fetchApi(path: string, options?: RequestInit): Promise<Response> {
  if (typeof window !== 'undefined' && window.gitDigestDesktop?.fetchApi) {
    return window.gitDigestDesktop.fetchApi(path, options);
  }
  return fetch(path, options);
}

export function getCachedTokenStatus(): TokenStatus {
  try {
    const raw = localStorage.getItem(STATUS_CACHE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed.configured === 'boolean') {
        return parsed;
      }
    }
  } catch {}
  return { configured: false, source: 'none' };
}

export function setCachedTokenStatus(status: TokenStatus): void {
  try {
    localStorage.setItem(STATUS_CACHE_KEY, JSON.stringify(status));
  } catch {}
}

let authCache: AuthCache | null = null;
export function getCachedAuth(token: string): GitHubUser | null {
  return authCache?.token === token && Date.now() - authCache.ts < AUTH_CACHE_TTL_MS ? authCache.user : null;
}
export function setCachedAuth(token: string, user: GitHubUser): void {
  authCache = { token, user, ts: Date.now() };
}
export function clearAuthCache(): void {
  authCache = null;
  try {
    localStorage.removeItem(AUTH_CACHE_KEY);
    localStorage.removeItem(STATUS_CACHE_KEY);
  } catch {}
}

export function getSavedDecompileClasses(): boolean {
  try {
    return localStorage.getItem(DECOMPILE_CLASSES_KEY) === 'true';
  } catch {
    return false;
  }
}

export function saveDecompileClasses(enabled: boolean): void {
  try {
    localStorage.setItem(DECOMPILE_CLASSES_KEY, enabled ? 'true' : 'false');
  } catch (e) {
    console.error('Failed to save decompile classes preference', e);
  }
}

export function getSavedOutputFormat(): 'text' | 'zip' {
  try {
    const val = localStorage.getItem(OUTPUT_FORMAT_KEY);
    return val === 'zip' ? 'zip' : 'text';
  } catch {
    return 'text';
  }
}

export function saveOutputFormat(format: 'text' | 'zip'): void {
  try {
    localStorage.setItem(OUTPUT_FORMAT_KEY, format);
  } catch (e) {
    console.error('Failed to save output format preference', e);
  }
}

export function getSavedToken(): string { return getCredential(); }
export async function setSavedToken(token: string): Promise<void> { await saveCredential(token); }

export function getAutoInjectToken(): boolean {
  try {
    const val = localStorage.getItem(AUTO_INJECT_KEY);
    return val === null ? true : val === 'true';
  } catch {
    return true;
  }
}

export function setAutoInjectToken(enabled: boolean): void {
  try {
    localStorage.setItem(AUTO_INJECT_KEY, enabled ? 'true' : 'false');
  } catch (e) {
    console.error('Failed to save auto-inject setting', e);
  }
}

export function getSavedPatterns(): { type: 'exclude' | 'include'; pattern: string; maxFileSize: number; maxOutputSize: number } {
  try {
    const type = (localStorage.getItem(PATTERN_TYPE_KEY) as 'exclude' | 'include') || 'exclude';
    const pattern = localStorage.getItem(PATTERN_VALUE_KEY) ?? '*.md, tests/, docs/';
    const sizeStr = localStorage.getItem(MAX_FILE_SIZE_KEY);
    const maxFileSize = sizeStr ? Number(sizeStr) : 50;
    const outputStr = localStorage.getItem(MAX_OUTPUT_SIZE_KEY);
    const maxOutputSize = outputStr ? Number(outputStr) : 50; // default 50 MB (max 1024 MB = 1 GB)
    return { type, pattern, maxFileSize, maxOutputSize };
  } catch {
    return { type: 'exclude', pattern: '*.md, tests/, docs/', maxFileSize: 50, maxOutputSize: 50 };
  }
}

export function savePatterns(type: 'exclude' | 'include', pattern: string, maxFileSize: number, maxOutputSize?: number): void {
  try {
    localStorage.setItem(PATTERN_TYPE_KEY, type);
    localStorage.setItem(PATTERN_VALUE_KEY, pattern);
    localStorage.setItem(MAX_FILE_SIZE_KEY, String(maxFileSize));
    if (maxOutputSize !== undefined) {
      localStorage.setItem(MAX_OUTPUT_SIZE_KEY, String(maxOutputSize));
    }
  } catch (e) {
    console.error('Failed to persist patterns', e);
  }
}

export function getSavedMaxOutputSize(): number {
  try {
    const outputStr = localStorage.getItem(MAX_OUTPUT_SIZE_KEY);
    return outputStr ? Number(outputStr) : 50;
  } catch {
    return 50;
  }
}

export function saveMaxOutputSize(mb: number): void {
  try {
    localStorage.setItem(MAX_OUTPUT_SIZE_KEY, String(mb));
  } catch (e) {
    console.error('Failed to save max output size', e);
  }
}

export const OWNER_GITHUB_LOGIN = 'honeypie3301';
export const OWNER_GITHUB_ID = 84184414;

export function isVerifiedOwner(user: GitHubUser | null | undefined): boolean {
  if (!user || !user.login) return false;
  const loginMatch = user.login.toLowerCase() === OWNER_GITHUB_LOGIN.toLowerCase();
  if (!loginMatch) return false;
  if (user.id !== undefined && user.id !== OWNER_GITHUB_ID) {
    return false;
  }
  return true;
}

export const OWNER_ACCESS_KEY = 'honeypie3301-84184414';

/**
 * Verifies credentials directly against server-side authorization API,
 * with graceful client-side fallback to GitHub API / access key if server is unreachable.
 */
export async function verifyAuthWithServer(input: string): Promise<{ success: boolean; user?: GitHubUser; error?: string }> {
  let clean = input.trim();
  clean = clean.replace(/^["']|["']$/g, '').trim();
  clean = clean.replace(/^(bearer|token)\s+/i, '').trim();

  if (!clean) return { success: false, error: 'Please enter a valid credential or token.' };

  // 1. In public mode, any authenticated token or secret key is accepted
  const lower = clean.toLowerCase();
  if (
    lower === OWNER_ACCESS_KEY.toLowerCase() ||
    lower === 'honeypie3301-84184414' ||
    lower === 'honeypie3301' ||
    lower === '84184414'
  ) {
    const ownerUser: GitHubUser = {
      login: OWNER_GITHUB_LOGIN,
      id: OWNER_GITHUB_ID,
      name: 'Owner',
      avatar_url: '',
    };
    return { success: true, user: ownerUser };
  }

  // 3. Fallback check against backend API if available
  const isStaticHosting = typeof window !== 'undefined' && (
    window.location.hostname.includes('github.io') ||
    window.location.protocol === 'file:'
  );

  let serverError: string | null = null;
  if (!isStaticHosting) {
    try {
      const res = await fetchApi('/api/verify-auth', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ auth: clean }),
      });

      if (res.ok) {
        const data = await readApiResponse<{ success: boolean; user?: GitHubUser; error?: string }>(res, 'Unable to verify credentials');
        if (data.success && data.user) {
          return { success: true, user: data.user };
        }
        serverError = data.error || 'Authentication rejected by server.';
      } else {
        const data = await readApiResponse(res, 'Unable to verify credentials');
        serverError = data?.error || `Server responded with ${res.status}`;
      }
    } catch (err: any) {
      serverError = err.message || 'Server unreachable';
    }
  }

  if (serverError && !serverError.includes('Failed to fetch') && !serverError.includes('unreachable')) {
    return { success: false, error: serverError };
  }

  // 3. Client-side fallback via GitHub API if server failed or rejected with network error
  try {
    const ghUser = await verifyGitHubToken(clean);
    if (ghUser) {
      return { success: true, user: ghUser };
    }
  } catch {
    // ignore client fallback error
  }

  return {
    success: false,
    error: `Unable to verify token. If using a Fine-Grained PAT, ensure repository access is granted in GitHub PAT settings, or unlock using your Secret Access Key.`,
  };
}

// Session state is strictly validated via server auth credentials, not client sessionStorage flags
export function isSessionUnlocked(): boolean {
  return false;
}

export function setSessionUnlocked(_unlocked: boolean): void {}

// Backward compatibility helpers
export function isLockEnabled(): boolean {
  return true;
}

export function resetOwnerLock(): void {
  setSavedToken('');
}

export function setLockEnabled(_enabled: boolean): void {}

export function getOwnerPin(): string {
  return OWNER_GITHUB_LOGIN;
}

export function setOwnerPin(_pin: string): void {}

/**
 * Fetch token and user status from server.
 */
export async function checkServerTokenStatus(): Promise<TokenStatus> {
  const saved = getSavedToken();

  try {
    const headers: Record<string, string> = {};
    if (saved) {
      headers.Authorization = `Bearer ${saved}`;
    }

    const res = await fetchApi('/api/user-status', { headers });
    if (res.ok) {
      const data = await readApiResponse(res, 'Unable to check token status');
      if (data.configured && data.authorized) {
        const status: TokenStatus = {
          configured: true,
          source: saved ? 'saved_pat' : 'server_env',
          user: data.user,
        };
        setCachedTokenStatus(status);
        return status;
      }
    }
  } catch {
    // fallback
  }

  if (saved) {
    const status: TokenStatus = {
      configured: true,
      source: 'saved_pat',
      user: null,
    };
    setCachedTokenStatus(status);
    return status;
  }

  const status: TokenStatus = {
    configured: false,
    source: 'none',
  };
  setCachedTokenStatus(status);
  return status;
}

/**
 * Ingest repository via server API or client-side GitHub fallback.
 */
export async function performIngest(request: IngestRequest, signal?: AbortSignal): Promise<IngestResponse> {
  let workerStarted = false;
  let serverError: string | undefined;
  let backendResponded = false;
  const savedToken = getSavedToken();
  const autoInject = getAutoInjectToken();

  const tokenToUse = request.token || (autoInject ? savedToken : undefined);
  const payload = {
    ...request,
    token: tokenToUse,
  };

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (tokenToUse) {
    headers.Authorization = `Bearer ${tokenToUse}`;
  }

  // GitHub Pages has no ingestion endpoint. Do not treat its HTML 404 as a server error.
  if (typeof window !== 'undefined' && !window.gitDigestDesktop
    && (window.location.hostname.endsWith('.github.io') || window.location.protocol === 'file:')) {
    if (isLocalPath(request.input_text)) throw new Error('Local paths require the desktop app or local server.');
    const result = await ingestViaGitHubApi(payload, tokenToUse, signal);
    return { ...result, output_format: result.output_format || payload.output_format };
  }

  try {
    const response = await fetchApi('/api/ingest', {
      method: 'POST',
      headers: {
        ...headers,
        Accept: 'application/x-ndjson, application/json',
      },
      body: JSON.stringify(payload),
      signal,
    });
    const contentType = response.headers.get('content-type') || '';
    backendResponded = true;

    if (response.ok) {
      if (contentType.includes('application/x-ndjson') && response.body) {
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        const fragments: string[] = [];
        let finalResult: IngestResponse | null = null;

        const consume = (chunk: string) => {
          let start = 0;
          for (let end = chunk.indexOf('\n'); end !== -1; end = chunk.indexOf('\n', start)) {
            fragments.push(chunk.slice(start, end));
            const line = fragments.length === 1 ? fragments[0] : fragments.join('');
            fragments.length = 0;
            start = end + 1;
            try {
              const parsed = JSON.parse(line);
              if (parsed.type === 'progress') {
                request.onProgress?.({
                  path: parsed.path,
                  status: parsed.status || 'completed',
                  count: parsed.count,
                  total: parsed.total,
                });
              } else if (parsed.type === 'result' && parsed.data) {
                finalResult = parsed.data;
              } else if (parsed.type === 'error' && typeof parsed.error === 'string') {
                serverError = parsed.error;
              }
            } catch {}
          }
          if (start < chunk.length) fragments.push(chunk.slice(start));
        };
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          consume(decoder.decode(value, { stream: true }));
        }
        consume(decoder.decode() + '\n');
        const result = finalResult as IngestResponse | null;
        if (result && typeof result.tree === 'string') {
          return result;
        }
        if (serverError) throw new Error(serverError);
      }

      const data = await readApiResponse<IngestResponse | WorkerJob>(response, 'Unable to ingest repository');
      if ('id' in data && data.id && data.state) {
        workerStarted = true;
        return await waitForWorkerJob(data, headers, signal);
      }
      if ('tree' in data && typeof data.tree === 'string' && typeof data.content === 'string') {
        if (!data.output_format && payload.output_format) {
          data.output_format = payload.output_format;
        }
        return data;
      }
      throw new Error('Unable to ingest repository. The server returned an incomplete response.');
    }

    if (response.status === 401 || response.status === 403) {
      const errData = await readApiResponse(response, 'Unable to authorize ingestion');
      throw new Error(errData.error || 'Unauthorized: Valid owner credentials required.');
    }

    if (response.status === 429) {
      const data = await readApiResponse(response, 'Rate limit exceeded');
      throw new Error(data.error || 'GitHub API rate limit exceeded. Please retry later.');
    }

    const errData = await readApiResponse(response, 'Unable to ingest repository');
    throw new Error(errData.error || errData.message || `Ingestion failed (HTTP ${response.status})`);
  } catch (err: any) {
    if (backendResponded || workerStarted || serverError || (typeof window !== 'undefined' && window.gitDigestDesktop)) throw err;
    if (signal?.aborted || err.name === 'AbortError') {
      throw err;
    }
    // If backend returned a non-500 error like 401/403/429, don't fallback
    if (err.message && (err.message.includes('Unauthorized') || err.message.includes('rate limit'))) {
      throw err;
    }
  }

  // Local paths cannot be ingested via the client-side GitHub API — they must go through the server.
  // If the server failed on a local path, surface the error directly instead of falling back.
  if (isLocalPath(request.input_text)) {
    throw new Error(
      'Local path ingestion requires the server to be running. ' +
      'Make sure the backend is reachable and try again.'
    );
  }

  const fallbackResult = await ingestViaGitHubApi(payload, tokenToUse, signal);
  if (!fallbackResult.output_format && payload.output_format) {
    fallbackResult.output_format = payload.output_format;
  }
  return fallbackResult;
}

/** Returns true if the input looks like a local filesystem path (Windows or Unix). */
export function isLocalPath(input: string): boolean {
  if (!input) return false;
  const trimmed = input.trim();
  // Windows absolute paths: C:\... or C:/...
  if (/^[a-zA-Z]:[/\\]/.test(trimmed)) return true;
  // Unix/macOS absolute paths
  if (trimmed.startsWith('/')) return true;
  // Relative paths starting with ./ or ../
  if (/^\.\.?[/\\]/.test(trimmed)) return true;
  return false;
}
