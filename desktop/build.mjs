import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { access, cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { execFileSync } from 'node:child_process';
import { build as bundle } from 'esbuild';
import { Arch, Platform, build } from 'electron-builder';

const project = path.resolve(import.meta.dirname, '..');
const tools = path.join(project, 'build', 'desktop-tools');
const gitRelease = '2.56.1';
const gitFilename = `MinGit-${gitRelease}-64-bit.zip`;
const gitArchive = path.join(tools, gitFilename);
const gitChecksum = '4a92850b6e917da4fd010669b614b55dccf5b0ec333a534cc4be4700dfefdafd';

if (process.platform !== 'win32') throw new Error('Run this build on Windows.');

await mkdir(tools, { recursive: true });
const stage = await mkdtemp(path.join(tools, 'stage-'));

try {
  try {
    await access(gitArchive);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const response = await fetch(`https://github.com/git-for-windows/git/releases/download/v${gitRelease}.windows.1/${gitFilename}`);
    if (!response.ok || !response.body) throw new Error(`MinGit download failed (HTTP ${response.status}).`);
    const download = path.join(stage, gitFilename);
    await pipeline(Readable.fromWeb(response.body), createWriteStream(download));
    await verifyGitArchive(download);
    await cp(download, gitArchive);
  }
  await verifyGitArchive(gitArchive);

  const git = path.join(stage, 'git');
  await mkdir(git);
  execFileSync('tar.exe', ['-xf', gitArchive, '-C', git], { stdio: 'inherit', windowsHide: true });

  const app = path.join(stage, 'app');
  await mkdir(app);
  const manifest = JSON.parse(await readFile(path.join(project, 'package.json'), 'utf8'));
  const electron = JSON.parse(await readFile(path.join(project, 'node_modules/electron/package.json'), 'utf8'));
  await writeFile(path.join(app, 'package.json'), JSON.stringify({
    name: 'gitdigest',
    version: manifest.version,
    main: 'main.cjs',
    author: 'honeypie3301',
    description: 'Local codebase ingestion',
  }));
  await Promise.all([
    cp(path.join(project, 'dist'), path.join(app, 'dist'), { recursive: true }),
    cp(path.join(project, 'desktop/main.cjs'), path.join(app, 'main.cjs')),
    cp(path.join(project, 'desktop/preload.cjs'), path.join(app, 'preload.cjs')),
    cp(path.join(project, 'LICENSE'), path.join(app, 'LICENSE')),
    bundle({
      absWorkingDir: project,
      entryPoints: ['server.ts'],
      outfile: path.join(app, 'server.cjs'),
      bundle: true,
      platform: 'node',
      format: 'cjs',
      external: ['vite'],
    }),
  ]);

  await build({
    projectDir: project,
    targets: Platform.WINDOWS.createTarget(['portable'], Arch.x64),
    publish: 'never',
    config: {
      appId: 'com.honeypie3301.gitdigest',
      productName: 'GitDigest',
      electronVersion: electron.version,
      directories: { app, output: 'build/desktop' },
      artifactName: 'GitDigest-Windows-x64.exe',
      asar: false,
      beforeBuild: async () => false,
      extraResources: [{ from: git, to: 'git' }],
      win: { icon: 'public/static/favicons/favicon.svg', signExecutable: false },
    },
  });
} finally {
  if (path.dirname(stage) === tools && path.basename(stage).startsWith('stage-')) {
    await rm(stage, { recursive: true, force: true, maxRetries: 3 });
  }
}

async function verifyGitArchive(archive) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(archive)) hash.update(chunk);
  if (hash.digest('hex') !== gitChecksum) throw new Error(`MinGit checksum mismatch: ${archive}`);
}
