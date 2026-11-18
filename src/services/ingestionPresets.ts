import type { PatternType, IngestionOutputFormat } from '../types';

export interface IngestionSettings {
  patternType: PatternType;
  pattern: string;
  maxFileSize: number;
  maxOutputSize: number;
  decompileClasses: boolean;
  outputFormat: IngestionOutputFormat;
}
export interface IngestionPreset extends IngestionSettings { name: string }
const KEY = 'gitdigest_ingestion_presets';

export function validPreset(value: unknown): value is IngestionPreset {
  if (!value || typeof value !== 'object') return false;
  const p = value as IngestionPreset;
  return typeof p.name === 'string' && p.name.trim().length > 0 && p.name.length <= 80
    && (p.patternType === 'include' || p.patternType === 'exclude') && typeof p.pattern === 'string'
    && Number.isFinite(p.maxFileSize) && p.maxFileSize > 0
    && Number.isFinite(p.maxOutputSize) && p.maxOutputSize >= 0.01 && p.maxOutputSize <= 1024
    && typeof p.decompileClasses === 'boolean' && (p.outputFormat === 'text' || p.outputFormat === 'zip');
}
export function getIngestionPresets(): IngestionPreset[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(KEY) || '[]');
    return Array.isArray(value) ? value.filter(validPreset).slice(0, 30) : [];
  } catch { return []; }
}
export function saveIngestionPresets(presets: IngestionPreset[]): void {
  if (presets.length > 30 || !presets.every(validPreset)) throw new Error('Use a name up to 80 characters and valid size limits (up to 30 presets).');
  // Store settings only, never repository URLs, credentials or mapping contents.
  localStorage.setItem(KEY, JSON.stringify(presets.map(p => ({
    name: p.name, patternType: p.patternType, pattern: p.pattern,
    maxFileSize: p.maxFileSize, maxOutputSize: p.maxOutputSize,
    decompileClasses: p.decompileClasses, outputFormat: p.outputFormat,
  }))));
}
