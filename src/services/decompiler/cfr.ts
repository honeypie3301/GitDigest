import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { promisify } from 'node:util';

const MAX_CLASS = 4 * 1024 * 1024;
const MAX_MAPPING = 16 * 1024 * 1024;
const MAX_CACHE = 8 * 1024 * 1024;
const cache = new Map<string, string>();
let cacheSize = 0;
let worker: ChildProcessWithoutNullStreams | undefined;
let queue = Promise.resolve();
let installed: Promise<void> | undefined;
let idle: ReturnType<typeof setTimeout> | undefined;
let workerMapping: string | undefined;
let previousMapping: string | undefined;
let mappingKey = '';

export function readClassMapping(value: unknown): string | undefined {
  if (value === undefined || value === '') return undefined;
  if (typeof value !== 'string' || Buffer.byteLength(value) > MAX_MAPPING ||
      !/^[^\s#]+\s+->\s+[^\s:]+:\s*$/m.test(value)) {
    throw new Error('Choose a ProGuard/R8 mapping file (mapping.txt, up to 16 MiB).');
  }
  return value;
}

export async function decompileClassSource(bytes: Uint8Array, mapping?: string): Promise<string> {
  if (bytes.length < 8 || bytes[0] !== 0xca || bytes[1] !== 0xfe || bytes[2] !== 0xba || bytes[3] !== 0xbe) {
    return '// Not a valid Java class file (missing CAFEBABE magic header)\n';
  }
  if (bytes.length > MAX_CLASS) return '// Java decompilation skipped because this class exceeds 4 MiB.\n';
  if (mapping !== previousMapping) {
    previousMapping = mapping;
    mappingKey = mapping ? createHash('sha256').update(mapping).digest('hex') : '';
  }
  const key = createHash('sha256').update(bytes).digest('hex') + mappingKey;
  const run = queue.then(async () => {
    const cached = cache.get(key);
    if (cached !== undefined) {
      cache.delete(key);
      cache.set(key, cached);
      return cached;
    }
    const output = await request(bytes, mapping);
    const size = Buffer.byteLength(output);
    if (size <= MAX_CACHE) {
      while (cacheSize + size > MAX_CACHE || cache.size >= 128) {
        const first = cache.keys().next().value!;
        cacheSize -= Buffer.byteLength(cache.get(first)!);
        cache.delete(first);
      }
      cache.set(key, output);
      cacheSize += size;
    }
    return output;
  });
  queue = run.then(() => {}, () => {});
  try {
    return await run;
  } catch (error) {
    return `// CFR decompilation unavailable: ${String((error as Error).message).replace(/[\r\n]+/g, ' ')}\n`;
  }
}

async function start() {
  const home = process.env.GITDIGEST_CFR_HOME;
  const bin = home ? path.join(home, 'java') : path.resolve('bin');
  if (home && !existsSync(path.join(home, 'java', 'bin', 'java.exe'))) {
    installed ??= unpackRuntime(home).catch(error => { installed = undefined; throw error; });
    await installed;
  }
  const jar = path.join(bin, 'cfr.jar');
  const bridge = path.join(bin, 'GitDigestCfr.jar');
  const command = home ? path.join(home, 'java', 'bin', 'java.exe') : 'java';
  const args = existsSync(bridge)
    ? ['-cp', [jar, bridge].join(path.delimiter), 'GitDigestCfr']
    : ['-cp', jar, path.join(bin, 'GitDigestCfr.java')];
  const child = spawn(command, ['-Xmx256m', '-XX:+UseSerialGC', ...args], { windowsHide: true });
  child.stderr.resume();
  child.stdin.on('error', () => {});
  child.on('error', () => {});
  child.on('close', () => { if (worker === child) worker = undefined; });
  workerMapping = undefined;
  worker = child;
  return child;
}

async function unpackRuntime(home: string) {
  await mkdir(home, { recursive: true });
  const target = path.join(home, 'java');
  const stage = await mkdtemp(path.join(home, 'runtime-'));
  try {
    await promisify(execFile)('tar.exe', ['-xf', path.join(home, 'java.zip'), '-C', stage], { windowsHide: true, timeout: 120_000 });
    await rename(stage, target).catch(error => {
      if (!existsSync(path.join(target, 'bin', 'java.exe'))) throw error;
    });
  } finally {
    if (path.dirname(stage) === home && path.basename(stage).startsWith('runtime-')) {
      await rm(stage, { recursive: true, force: true });
    }
  }
}

async function request(bytes: Uint8Array, mapping?: string): Promise<string> {
  clearTimeout(idle);
  const child = worker ?? await start();
  try {
    return await new Promise<string>((resolve, reject) => {
      const lines = createInterface({ input: child.stdout });
      const finish = (error?: Error, output?: string) => {
        clearTimeout(timer);
        lines.close();
        child.off('error', onError);
        child.off('close', onClose);
        if (error) reject(error);
        else resolve(output!);
      };
      const onError = () => finish(new Error('Java is unavailable. Install a JDK for server-side decompilation.'));
      const onClose = () => finish(new Error('The Java decompiler exited.'));
      const timer = setTimeout(() => {
        finish(new Error('The class exceeded the decompilation time limit.'));
        child.kill();
        if (worker === child) worker = undefined;
      }, 12_000);
      child.once('error', onError);
      child.once('close', onClose);
      lines.once('line', line => {
        const [status, value] = line.split('\t', 2);
        const output = Buffer.from(value || '', 'base64').toString('utf8');
        if (status === 'ok') finish(undefined, output);
        else finish(new Error(output || 'Invalid decompiler response.'));
      });
      const encoded = mapping === workerMapping && mapping ? '-' : Buffer.from(mapping ?? '').toString('base64');
      workerMapping = mapping;
      child.stdin.write(`${Buffer.from(bytes).toString('base64')}\t${encoded}\n`);
    });
  } finally {
    idle = setTimeout(() => {
      if (worker === child) worker = undefined;
      child.stdin.end();
    }, 20_000);
    idle.unref();
  }
}
