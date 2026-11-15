import assert from 'node:assert/strict';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { setTimeout as sleep } from 'node:timers/promises';

const [electron, rust] = process.argv.slice(2).map(file => path.resolve(file));
if (!electron || !rust) {
  throw new Error('Pass the v1.0.0 unpacked resources/app folder and the release-mode benchmark_api.exe.');
}

const temp = await realpath(tmpdir());
const sandbox = await mkdtemp(path.join(temp, 'gitdigest-test-'));
const fixture = path.join(sandbox, 'fixture');
const forceRateLimit = process.env.GITDIGEST_BENCH_FORCE_RATE_LIMIT === '1';
const children = [];
try {
  await mkdir(fixture);
  for (let n = 0; n < 20; n++) {
    const folder = path.join(fixture, `folder-${String(n).padStart(2, '0')}`);
    await mkdir(folder);
    await Promise.all(Array.from({ length: 100 }, (_, i) =>
      writeFile(path.join(folder, `file-${String(i).padStart(3, '0')}.txt`), 'export const sample = 123;\n'.repeat(60))));
  }
  for (const name of ['é.txt', 'A test.txt', 'a-test.txt', '_first.txt', '.hidden.txt', '🦊.txt']) {
    await writeFile(path.join(fixture, name), `Some text in ${name}\n`);
  }
  await writeFile(path.join(fixture, 'Invalid.class'), 'invalid class');
  const binaryFolder = path.join(fixture, 'binary');
  await mkdir(binaryFolder);
  const binary = Buffer.alloc(8 * 1024 * 1024);
  await Promise.all(Array.from({ length: 12 }, (_, i) => writeFile(path.join(binaryFolder, `${i}.bin`), binary)));

  const old = launch(process.execPath, ['server.cjs'], {
    cwd: electron, env: { ...process.env, GITDIGEST_DESKTOP_KEY: 'benchmark' },
  });
  const env = { ...process.env, PATH: path.join(process.env.SystemRoot, 'System32') };
  if (forceRateLimit) {
    const preload = path.join(sandbox, 'return-429.cjs');
    await writeFile(preload, `
      const originalFetch = globalThis.fetch;
      globalThis.fetch = (url, ...args) =>
        new URL(url).hostname === 'api.github.com'
          ? Promise.resolve(new Response('Test rate limit', { status: 429 }))
          : originalFetch(url, ...args);
    `);
    env.NODE_OPTIONS = `--require "${preload.replaceAll('\\', '/')}"`;
  }
  const next = launch(rust, [path.join(sandbox, 'cache')], { env });
  const [oldHost, newHost] = await Promise.all([
    listen(old, /running on http:\/\/(127\.0\.0\.1:\d+)/),
    listen(next, /^(127\.0\.0\.1:\d+)$/),
  ]);
  for (const input of [
    { input_text: path.join(fixture, 'é.txt') },
    { input_text: fixture, pattern_type: 'include', pattern: '*.txt', max_file_size: 0.01 },
    { input_text: fixture, pattern_type: 'exclude', pattern: 'folder-01, [', max_file_size: 0.01 },
    { input_text: fixture },
    { input_text: path.join(fixture, 'Invalid.class'), decompile_classes: true },
  ]) {
    const [before, after] = await Promise.all([ingest(oldHost, input), ingest(newHost, input)]);
    for (const key of Object.keys(before)) {
      if (after[key] === before[key]) continue;
      const a = String(before[key]);
      const b = String(after[key]);
      let difference = 0;
      while (a[difference] === b[difference]) difference++;
      assert.fail(`Output differs in ${key} at ${difference}\nElectron: ${a.slice(difference, difference + 150)}\nRust: ${b.slice(difference, difference + 150)}`);
    }
  }
  console.log('Parity passed for single files, Unicode and punctuation, filters, size limits, binary files, and Java class decompilation.');
  const missing = path.join(fixture, 'missing');
  for (const host of [oldHost, newHost]) {
    const response = await fetch(`http://${host}/api/ingest`, options({ input_text: missing }, true));
    assert.ok([200, 404].includes(response.status));
    assert.match(await response.text(), /could not be read/i);
  }

  for (const [name, input] of [
    ['2,006 text files', { input_text: fixture, pattern_type: 'include', pattern: '*.txt' }],
    ['12 × 8 MB binary files', { input_text: binaryFolder }],
    ['mixed directory', { input_text: fixture }],
  ]) {
    const oldTimes = [];
    const newTimes = [];
    for (let i = 0; i < 9; i++) {
      const runs = [[oldHost, oldTimes], [newHost, newTimes]];
      if (i % 2) runs.reverse();
      for (const [host, times] of runs) {
        const start = performance.now();
        const response = await fetch(`http://${host}/api/ingest`, options(input, true));
        assert.equal(response.status, 200);
        await response.arrayBuffer();
        if (i) times.push(performance.now() - start);
      }
    }
    console.log(`${name}: Electron ${median(oldTimes).toFixed(1)} ms, Rust ${median(newTimes).toFixed(1)} ms`);
  }

  const online = await ingest(newHost, { input_text: 'https://github.com/octocat/Hello-World' });
  assert.match(online.summary, /Repository: octocat\/Hello-World/);
  if (forceRateLimit) {
    assert.equal(online.mode_switched, true);
    console.log('A shallow clone with bundled Git succeeded after a simulated REST HTTP 429.');
  } else {
    console.log('Live public GitHub ingestion passed through the bundled compatibility engine.');
  }
} finally {
  await Promise.all(children.map(async child => {
    if (child.exitCode === null) {
      const done = once(child, 'exit');
      // The build process is a test-only tree, which includes its Git/Node child.
      const kill = spawn('taskkill.exe', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' });
      await once(kill, 'exit');
      await Promise.race([done, sleep(3000)]);
    }
  }));
  const resolved = await realpath(sandbox);
  if (path.dirname(resolved) === temp && path.basename(resolved).startsWith('gitdigest-test-')) {
    await rm(resolved, { recursive: true, force: true });
  }
}

function launch(file, args, options) {
  const child = spawn(file, args, { ...options, windowsHide: true, stdio: ['ignore', 'pipe', 'inherit'] });
  children.push(child);
  return child;
}

async function listen(child, pattern) {
  const lines = createInterface({ input: child.stdout });
  const match = await Promise.race([
    (async () => {
      for await (const line of lines) {
        const match = pattern.exec(line);
        if (match) return match[1];
      }
      throw new Error('API exited during startup.');
    })(),
    sleep(15000, undefined, { ref: false }).then(() => { throw new Error('API startup timed out.'); }),
  ]);
  return match;
}

function options(body, stream = false) {
  return {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-gitdigest-desktop': 'benchmark',
      origin: 'http://tauri.localhost',
      ...(stream ? { accept: 'application/x-ndjson' } : { 'x-no-stream': '1' }),
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60000),
  };
}

async function ingest(host, body) {
  const response = await fetch(`http://${host}/api/ingest`, options(body));
  const data = await response.json();
  assert.equal(response.status, 200, JSON.stringify(data));
  return data;
}

function median(times) {
  times.sort((a, b) => a - b);
  const middle = Math.floor(times.length / 2);
  return (times[middle - 1] + times[middle]) / 2;
}
