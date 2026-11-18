import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildIndividualFilesZip, normalizeZipPath } from '../../src/services/zipExporter';
import { splitDigestSafely } from '../../src/services/textSplitter';
import { digestByteSize } from '../../src/services/digestExport';
import { validPreset, getIngestionPresets, saveIngestionPresets } from '../../src/services/ingestionPresets';
import { initializeCredentials, getCredential, saveCredential } from '../../src/services/credentials';

function mockGlobal(t: import('node:test').TestContext, name: string, value: unknown) {
  const original = Object.getOwnPropertyDescriptor(globalThis, name);
  Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  t.after(() => {
    if (original) Object.defineProperty(globalThis, name, original);
    else Reflect.deleteProperty(globalThis, name);
  });
}

test('ZIP export preserves source, metadata, mapped-name and case collisions', async () => {
  const java = '/*\n * Decompiled with CFR 0.152.\n */\npublic class Readable {}';
  const zip = buildIndividualFilesZip([
    { path: 'SUMMARY.txt', text: 'source summary' },
    { path: 'classes/Readable.java', text: 'original source' },
    { path: 'classes/A.class [Decompiled Java]', text: java },
    { path: 'classes/B.class [Decompiled Java]', text: java + '\n// another class' },
    { path: 'readme.txt', text: 'lowercase' },
    { path: 'README.txt', text: 'uppercase' },
    { path: 'folder', text: 'file named like a directory' },
    { path: 'folder/nested.txt', text: 'nested' },
  ], 'generated summary', 'tree');
  const files = Object.values(zip.files).filter(file => !file.dir);
  assert.equal(files.length, 10);
  const names = files.map(file => file.name.toLowerCase());
  assert.equal(new Set(names).size, files.length);
  const contents = await Promise.all(files.map(file => file.async('string')));
  for (const value of ['source summary', 'original source', java, java + '\n// another class', 'lowercase', 'uppercase', 'file named like a directory', 'nested', 'generated summary', 'tree']) {
    assert.ok(contents.includes(value), value);
  }
  assert.equal(normalizeZipPath('folder\\nested.txt'), 'folder/nested.txt');
  assert.throws(() => normalizeZipPath('../escape.txt'), /Unsafe/);
  assert.throws(() => normalizeZipPath('C:\\escape.txt'), /Unsafe/);
});

test('split exports preserve oversized files without producing an empty header-only part', () => {
  const block = '================================================\nFile: large.txt\n================================================\n' + '日'.repeat(100);
  const text = 'summary\n\n' + block;
  const parts = splitDigestSafely(text, 100, 'digest.txt');
  assert.equal(parts.length, 1);
  assert.equal(parts[0].content, text);
  assert.equal(parts[0].byteLength, Buffer.byteLength(text));
  assert.ok(parts[0].byteLength > 100);
  assert.equal(digestByteSize({ summary: '日', tree: '🦊', content: 'code' }), Buffer.byteLength('日\n\n🦊\n\ncode'));
  assert.equal(digestByteSize({ summary: '', tree: '', content: 'preview', content_preview_truncated: true }), null);
  assert.throws(() => splitDigestSafely(text, 0, 'digest.txt'));
});

test('presets validate settings and never save credentials or mapping contents', t => {
  const storage = new Map<string, string>();
  mockGlobal(t, 'localStorage', {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
  });
  const preset = { name: 'Java sources', patternType: 'include' as const, pattern: '*.java', maxFileSize: 2, maxOutputSize: 10, decompileClasses: true, outputFormat: 'zip' as const };
  assert.ok(validPreset(preset));
  assert.equal(validPreset({ ...preset, maxOutputSize: -1 }), false);
  saveIngestionPresets([{ ...preset, token: 'must-not-persist', class_mapping: 'private map' } as typeof preset]);
  assert.deepEqual(getIngestionPresets(), [preset]);
  assert.doesNotMatch([...storage.values()].join(), /must-not-persist|private map/);
  storage.set('gitdigest_ingestion_presets', '[null,{},42]');
  assert.deepEqual(getIngestionPresets(), []);
});

test('legacy tokens migrate into native storage and clear-text auth caches are removed', async t => {
  const storage = new Map([['gitingest_custom_pat', 'legacy-token'], ['gitingest_auth_cache', 'old-cleartext-cache']]);
  mockGlobal(t, 'localStorage', {
    getItem: (key: string) => storage.get(key) ?? null,
    removeItem: (key: string) => storage.delete(key),
  });
  let protectedToken = '';
  mockGlobal(t, 'window', { gitDigestDesktop: {
    readToken: async () => protectedToken,
    saveToken: async (value: string) => { protectedToken = value; },
  } });
  await initializeCredentials();
  assert.equal(getCredential(), 'legacy-token');
  assert.equal(protectedToken, 'legacy-token');
  assert.equal(storage.size, 0);
  await saveCredential('replacement');
  assert.equal(protectedToken, 'replacement');
  await saveCredential('');
  assert.equal(getCredential(), '');
  assert.equal(protectedToken, '');
});
