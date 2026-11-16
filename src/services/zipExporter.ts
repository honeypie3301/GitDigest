import JSZip from 'jszip';
import { IngestResponse } from '../types';
import { fullDigestSection } from './digestExport';

export interface ExtractedFile {
  path: string;
  text: string;
}

/**
 * Extracts individual files from an IngestResponse (either from response.files or parsed from response.content).
 */
export function extractIndividualFiles(result: IngestResponse): ExtractedFile[] {
  if (result.files && result.files.length > 0) {
    return result.files.map((f) => ({
      path: f.path,
      text: f.text ?? '',
    }));
  }

  if (!result.content) return [];

  const delimiter = '================================================\nFile: ';
  if (!result.content.includes(delimiter)) return [];

  const chunks = result.content.split(delimiter);
  const files: ExtractedFile[] = [];

  for (const chunk of chunks) {
    if (!chunk.trim()) continue;
    const newlineIdx = chunk.indexOf('\n');
    if (newlineIdx === -1) continue;

    const filePath = chunk.slice(0, newlineIdx).trim();
    const rest = chunk.slice(newlineIdx + 1);

    const secondBarIdx = rest.indexOf('================================================\n');
    if (secondBarIdx === -1) continue;

    const fileText = rest.slice(secondBarIdx + 49);
    files.push({
      path: filePath,
      text: fileText.replace(/\r\n/g, '\n'),
    });
  }

  return files;
}

/**
 * Normalizes file paths for ZIP archives:
 * - Strips leading / and \
 * - Converts decompiled java paths e.g. 'Class.class [Decompiled Java]' to 'Class.java'
 */
export function normalizeZipPath(rawPath: string, source?: string): string {
  let clean = rawPath.replace(/^[\\/]+/, '').trim();
  if (clean.endsWith(' [Decompiled Java]')) {
    clean = clean.replace(/\.class\s*\[Decompiled Java\]$/i, '.java');
    // The class declaration can have a new name after applying a mapping.
    if (source?.startsWith('/*\n * Decompiled with CFR ')) {
      const declaration = /^(?:public |private |protected |static |final |abstract |strictfp |sealed |non-sealed )*(?:class|interface|enum|record|@interface) ([\p{ID_Start}_$][\p{ID_Continue}$]*)/mu.exec(source);
      if (declaration) clean = clean.slice(0, clean.lastIndexOf('/') + 1) + declaration[1] + '.java';
    }
  }
  return clean;
}

/**
 * Determines optimal ZIP compression method:
 * - On Localhost / local loopback: Defaults to 'STORE' (0% CPU compression pass, ~3x-5x faster packaging)
 * - On Remote / Hosted deployments: Defaults to 'DEFLATE' (reduces bandwidth footprint)
 */
export function getBestCompressionMethod(preferred?: 'DEFLATE' | 'STORE' | 'auto'): 'DEFLATE' | 'STORE' {
  if (preferred && preferred !== 'auto') return preferred;
  if (typeof window !== 'undefined') {
    const host = window.location.hostname;
    if (window.gitDigestDesktop || host === 'localhost' || host === '127.0.0.1' || host.endsWith('.local')) {
      return 'STORE';
    }
  }
  return 'DEFLATE';
}

/**
 * Creates and downloads a .zip archive where each ingested file is individually placed
 * in its respective directory structure, with optional SUMMARY.txt and DIRECTORY_STRUCTURE.txt.
 */
export async function downloadIndividualFilesAsZip(
  result: IngestResponse,
  customZipName?: string,
  onProgress?: (percent: number, currentFile: string) => void,
  preferredMethod: 'DEFLATE' | 'STORE' | 'auto' = 'auto'
): Promise<void> {
  const content = result.content_preview_truncated ? await fullDigestSection(result, 'content') : result.content;
  const tree = result.tree_preview_truncated ? await fullDigestSection(result, 'tree') : result.tree;
  const files = extractIndividualFiles({ ...result, content });
  const zip = new JSZip();

  // 1. Add SUMMARY and Directory Structure metadata files
  if (result.summary) {
    zip.file('SUMMARY.txt', result.summary);
  }
  if (tree) {
    zip.file('DIRECTORY_STRUCTURE.txt', tree);
  }

  // 2. Add individual files preserving directory hierarchy
  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    const zipPath = normalizeZipPath(file.path, file.text);
    if (zipPath) {
      zip.file(zipPath, file.text);
    }
    if (onProgress && i % 10 === 0) {
      onProgress(Math.round(((i + 1) / (files.length || 1)) * 50), zipPath);
    }
  }

  // 3. Auto-detect optimal compression method (STORE on localhost, DEFLATE on cloud)
  const method = getBestCompressionMethod(preferredMethod);
  const zipOptions: JSZip.JSZipGeneratorOptions<'blob'> = {
    type: 'blob',
    compression: method,
    ...(method === 'DEFLATE' ? { compressionOptions: { level: 6 } } : {}),
  };

  // 4. Generate ZIP binary blob
  const blob = await zip.generateAsync(zipOptions, (metadata) => {
    if (onProgress) {
      onProgress(50 + Math.round(metadata.percent / 2), metadata.currentFile || 'Compressing archive...');
    }
  });

  // 5. Determine file name
  const repoSlug = (result.repo_name || 'repository').replace(/[/\\:]/g, '_');
  const subSlug = result.subpath
    ? `_${result.subpath.replace(/^[/\\]+|[/\\]+$/g, '').replace(/[/\\:]/g, '_')}`
    : '';
  const finalFilename = customZipName || `${repoSlug}${subSlug}_files.zip`;

  // 6. Trigger download
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = finalFilename;
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  URL.revokeObjectURL(url);
}
