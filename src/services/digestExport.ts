import type { IngestResponse } from '../types';

const desktopSections = new WeakMap<IngestResponse, { content: Blob; tree: Blob }>();
const desktopArtifacts = new WeakMap<IngestResponse, { path: string; size: number; treeStart: number; contentStart: number }>();
const DESKTOP_PREVIEW = 50_000;

function copyPreview(text: string) {
  if (text.length <= DESKTOP_PREVIEW) return text;
  // Copy the prefix so a V8 substring cannot keep the entire digest alive.
  const end = /[\uD800-\uDBFF]/.test(text[DESKTOP_PREVIEW - 1]) ? DESKTOP_PREVIEW - 1 : DESKTOP_PREVIEW;
  return new TextDecoder('utf-8', { ignoreBOM: true }).decode(new TextEncoder().encode(text.slice(0, end)));
}

export function keepDesktopPreview(result: IngestResponse): IngestResponse {
  if (result.artifact_url || (result.content.length <= DESKTOP_PREVIEW && result.tree.length <= DESKTOP_PREVIEW)) {
    return result;
  }
  const preview = {
    ...result,
    content: copyPreview(result.content),
    tree: copyPreview(result.tree),
    content_chars: result.content.length,
    content_preview_truncated: result.content.length > DESKTOP_PREVIEW,
    tree_preview_truncated: result.tree.length > DESKTOP_PREVIEW,
  };
  desktopSections.set(preview, { content: new Blob([result.content]), tree: new Blob([result.tree]) });
  return preview;
}

export async function storeDesktopDigest(result: IngestResponse) {
  const preview = keepDesktopPreview(result);
  const local = desktopSections.get(preview);
  const desktop = window.gitDigestDesktop;
  if (!local || !desktop?.fetchApi) return preview;
  const header = new Blob([result.summary, '\n\n']);
  const body = new Blob([header, local.tree, '\n\n', local.content]);
  try {
    const response = await desktop.fetchApi('/api/artifact', { method: 'POST', body });
    if (response.ok) {
      const { id } = await response.json();
      if (typeof id === 'string' && /^[a-zA-Z0-9-]+$/.test(id)) {
        desktopArtifacts.set(preview, {
          path: `/api/artifact/${id}`,
          size: body.size,
          treeStart: header.size,
          contentStart: header.size + local.tree.size + 2,
        });
        desktopSections.delete(preview);
      }
    }
  } catch {
    // A full temporary directory should still allow browsing and exporting the digest.
  }
  return preview;
}

export function releaseDesktopDigest(result?: IngestResponse | null) {
  const artifact = result && desktopArtifacts.get(result);
  if (!artifact) return;
  void window.gitDigestDesktop?.fetchApi?.(artifact.path, { method: 'DELETE', keepalive: true }).catch(() => {});
}

async function readDesktopArtifact(result: IngestResponse, section: 'all' | 'tree' | 'content') {
  const artifact = desktopArtifacts.get(result)!;
  const start = section === 'tree' ? artifact.treeStart : section === 'content' ? artifact.contentStart : 0;
  const end = section === 'tree' ? artifact.contentStart - 2 : artifact.size;
  if (start === end) return new Response('');
  const response = await window.gitDigestDesktop?.fetchApi?.(artifact.path,
    section === 'all' ? undefined : { headers: { Range: `bytes=${start}-${end - 1}` } },
  );
  if (!response?.ok) throw new Error('The local export is unavailable. Please ingest again.');
  return response;
}

export async function desktopDownloadBlob(result: IngestResponse, maxBytes: number) {
  const artifact = desktopArtifacts.get(result);
  return artifact && artifact.size <= maxBytes ? (await readDesktopArtifact(result, 'all')).blob() : null;
}

export async function artifactUrl(result: IngestResponse) {
  return result.refreshArtifactUrl ? result.refreshArtifactUrl() : result.artifact_url!;
}

export async function fullDigestSection(result: IngestResponse, section: 'all' | 'tree' | 'content') {
  if (desktopArtifacts.has(result)) return (await readDesktopArtifact(result, section)).text();
  const local = desktopSections.get(result);
  if (local) {
    if (section !== 'all') return local[section].text();
    return new Blob([result.summary, '\n\n', local.tree, '\n\n', local.content]).text();
  }
  if (section === 'tree' && !result.tree_preview_truncated) return result.tree;
  if (section === 'content' && !result.content_preview_truncated) return result.content;
  if (!result.artifact_url) return `${result.summary}\n\n${result.tree}\n\n${result.content}`;
  const response = await fetch(await artifactUrl(result));
  if (!response.ok) throw new Error('Export link expired or unavailable. Please ingest again.');
  const digest = await response.text();
  if (section === 'tree') return digest.slice(result.summary.length + 2, result.content_offset! - 2);
  if (section === 'content') return digest.slice(result.content_offset);
  return digest;
}
