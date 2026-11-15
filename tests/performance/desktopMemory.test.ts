import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fullDigestSection, keepDesktopPreview } from '../../src/services/digestExport';
import { performIngest } from '../../src/services/ingest';

test('desktop previews preserve the complete tree, content and combined export', async () => {
  const original = {
    summary: 'Fixture',
    tree: '├── sample\n'.repeat(8000),
    content: 'a'.repeat(49_999) + '🦊\r\n' + 'b'.repeat(2000),
  };
  const result = keepDesktopPreview(original);
  assert.equal(result.content.length, 49_999);
  assert.equal(result.tree.length, 50_000);
  assert.equal(result.content_chars, original.content.length);
  assert.equal(await fullDigestSection(result, 'content'), original.content);
  assert.equal(await fullDigestSection(result, 'tree'), original.tree);
  assert.equal(await fullDigestSection(result, 'all'), `${original.summary}\n\n${original.tree}\n\n${original.content}`);
});

test('NDJSON ingestion handles fragmented UTF-8, progress and an unterminated result', async (t) => {
  const result = { summary: 'Fixture', tree: '🦊', content: '日'.repeat(50_000) };
  const body = Buffer.from(
    JSON.stringify({ type: 'progress', path: '🦊.txt', count: 1 }) + '\r\n' +
    JSON.stringify({ type: 'result', data: result }),
  );
  t.mock.method(globalThis, 'fetch', async () => new Response(new ReadableStream({
    start(controller) {
      for (let i = 0; i < body.length; i += 73) controller.enqueue(body.subarray(i, i + 73));
      controller.close();
    },
  }), { headers: { 'Content-Type': 'application/x-ndjson' } }));
  const paths: string[] = [];
  assert.deepEqual(await performIngest({ input_text: 'owner/repo', onProgress: event => paths.push(event.path) }), result);
  assert.deepEqual(paths, ['🦊.txt']);
});
