import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { access, appendFile, cp, mkdir, readFile, rename } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGzip } from 'node:zlib';
import { build } from 'esbuild';

const project = path.resolve(import.meta.dirname, '..');
const desktop = path.join(project, 'desktop/rust');
const output = path.join(project, 'build/desktop-rust', process.env.GITDIGEST_BUILD_SUBDIR ?? '');
const payload = path.join(output, 'payload');
const tools = path.join(project, 'build/desktop-tools');
const archive = path.join(tools, 'MinGit-2.56.1-64-bit.zip');
const checksum = '4a92850b6e917da4fd010669b614b55dccf5b0ec333a534cc4be4700dfefdafd';

if (process.platform !== 'win32' || process.arch !== 'x64' || Number(process.versions.node.split('.')[0]) < 22) {
  throw new Error('Build with 64-bit Node.js 22 or newer on Windows.');
}

await mkdir(payload, { recursive: true });
await mkdir(tools, { recursive: true });
try {
  await access(archive);
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
  const temp = path.join(tools, `MinGit-${process.pid}.zip`);
  const response = await fetch('https://github.com/git-for-windows/git/releases/download/v2.56.1.windows.1/MinGit-2.56.1-64-bit.zip');
  if (!response.ok || !response.body) throw new Error(`MinGit download failed (HTTP ${response.status}).`);
  await pipeline(Readable.fromWeb(response.body), createWriteStream(temp, { flags: 'wx' }));
  await verifyGit(temp);
  await rename(temp, archive);
}
await verifyGit(archive);
const javaRuntime = path.join(payload, 'java-runtime');
const javaClasses = path.join(payload, 'java-classes');
await mkdir(javaClasses, { recursive: true });
if (!await access(path.join(javaRuntime, 'bin/java.exe')).then(() => true, () => false)) {
  execFileSync('jlink.exe', [
    '--add-modules', 'java.base,java.logging',
    '--strip-debug', '--no-header-files', '--no-man-pages', '--output', javaRuntime,
  ], { stdio: 'inherit', windowsHide: true });
}
const cfrJar = path.join(project, 'bin/cfr.jar');
execFileSync('javac.exe', ['--release', '11', '-cp', cfrJar, '-d', javaClasses, path.join(project, 'bin/GitDigestCfr.java')], { stdio: 'inherit', windowsHide: true });
execFileSync('jar.exe', ['--create', '--file', path.join(javaRuntime, 'GitDigestCfr.jar'), '-C', javaClasses, '.'], { stdio: 'inherit', windowsHide: true });
await cp(cfrJar, path.join(javaRuntime, 'cfr.jar'));
await cp(path.join(project, 'bin/CFR-LICENSE.txt'), path.join(javaRuntime, 'CFR-LICENSE.txt'));
execFileSync('tar.exe', ['--format', 'zip', '-cf', path.join(payload, 'java.zip'), '-C', javaRuntime, '.'], { stdio: 'inherit', windowsHide: true });
await Promise.all([
  cp(archive, path.join(payload, 'mingit.zip')),
  pipeline(createReadStream(process.execPath), createGzip({ level: 3 }), createWriteStream(path.join(payload, 'node.exe.gz'))),
  build({
    absWorkingDir: project,
    entryPoints: ['server.ts'],
    outfile: path.join(payload, 'server.cjs'),
    bundle: true,
    platform: 'node',
    format: 'cjs',
    external: ['vite'],
  }),
]);

const env = { ...process.env };
const args = process.argv.slice(2);
const target = path.resolve(project, env.CARGO_TARGET_DIR || path.join(output, 'target'));
env.CARGO_TARGET_DIR = target;
const options = { cwd: desktop, env, stdio: 'inherit', windowsHide: true };
const buildArgs = ['build', '--release', '--locked', '--bin', 'gitdigest'];
if (args.includes('--benchmark')) buildArgs.push('--example', 'benchmark_api');
execFileSync('cargo.exe', buildArgs, options);

const release = path.join(target, 'release');
const portable = path.join(output, 'GitDigest.exe');
await packageExe(path.join(release, 'gitdigest.exe'), portable);
if (args.includes('--benchmark')) {
  await packageExe(path.join(release, 'examples/benchmark_api.exe'), path.join(output, 'benchmark_api.exe'));
}
if (!args.includes('--no-installer')) {
  const stage = path.join(output, 'installer-stage');
  const stageRelease = path.join(stage, 'release');
  await mkdir(stageRelease, { recursive: true });
  await cp(portable, path.join(stageRelease, 'GitDigest.exe'));
  const cli = path.join(project, 'node_modules/@tauri-apps/cli/tauri.js');
  execFileSync(process.execPath, [cli, 'bundle', '--ci', '--bundles', 'nsis', '--no-sign', '--no-binary-patching'], {
    ...options, env: { ...env, CARGO_TARGET_DIR: stage },
  });
  const { version } = JSON.parse(await readFile(path.join(desktop, 'tauri.conf.json'), 'utf8'));
  await cp(path.join(stageRelease, `bundle/nsis/GitDigest_${version}_x64-setup.exe`), path.join(output, 'GitDigest-Windows-x64-Setup.exe'));
}

async function packageExe(source, destination) {
  await cp(source, destination);
  const digest = createHash('sha256');
  const footer = Buffer.alloc(80);
  footer.write('GITDIGEST-PACK2\0', 0, 'ascii');
  const files = ['node.exe.gz', 'mingit.zip', 'server.cjs', 'java.zip'];
  for (const [index, file] of files.entries()) {
    let length = 0;
    for await (const chunk of createReadStream(path.join(payload, file), { highWaterMark: 1024 * 1024 })) {
      length += chunk.length;
      digest.update(chunk);
      await appendFile(destination, chunk);
    }
    footer.writeBigUInt64LE(BigInt(length), 16 + index * 8);
  }
  digest.digest().copy(footer, 48);
  await appendFile(destination, footer);
}

async function verifyGit(file) {
  const digest = createHash('sha256').update(await readFile(file)).digest('hex');
  if (digest !== checksum) throw new Error(`MinGit checksum mismatch: ${file}`);
}
