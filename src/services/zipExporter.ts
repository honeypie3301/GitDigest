import JSZip from 'jszip';
import { IngestResponse } from '../types';
import { fullDigestSection } from './digestExport';
import { downloadBlob } from './download';

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
  let clean = rawPath.replace(/\\/g, '/').replace(/^\/+/, '').trim();
  if (clean.split('/').some(part => part === '..') || /[:\x00-\x1f]/.test(clean)) {
    throw new Error(`Unsafe ZIP file path: ${rawPath}`);
  }
  clean = clean.split('/').filter(part => part && part !== '.').join('/');
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

export function buildIndividualFilesZip(files: ExtractedFile[], summary: string, tree: string): JSZip {
  const zip = new JSZip();
  const entries = files.map(file => ({ path: normalizeZipPath(file.path, file.text), text: file.text }));
  const occupied = new Set<string>();
  // Reserve all directories before adding files (including files named like a directory).
  for (const entry of entries) {
    const parts = entry.path.split('/');
    for (let i = 1; i < parts.length; i++) occupied.add(parts.slice(0, i).join('/').toLowerCase());
  }
  const add = (name: string, text: string) => {
    if (!name) return;
    const dot = name.lastIndexOf('.') > name.lastIndexOf('/') ? name.lastIndexOf('.') : name.length;
    let candidate = name;
    for (let n = 2; occupied.has(candidate.toLowerCase()); n++) {
      candidate = `${name.slice(0, dot)} (${n})${name.slice(dot)}`;
    }
    occupied.add(candidate.toLowerCase());
    zip.file(candidate, text);
  };
  for (const entry of entries) add(entry.path, entry.text);
  if (summary) add('SUMMARY.txt', summary);
  if (tree) add('DIRECTORY_STRUCTURE.txt', tree);
  return zip;
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
  const zip = buildIndividualFilesZip(files, result.summary, tree);
  onProgress?.(50, 'Files packaged');

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
  downloadBlob(blob, finalFilename);
}
