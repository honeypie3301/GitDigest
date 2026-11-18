const { app, BrowserWindow, dialog, ipcMain, shell, utilityProcess, safeStorage } = require('electron');
const fs = require('node:fs/promises');
const { randomBytes } = require('node:crypto');
const path = require('node:path');

const origin = 'http://127.0.0.1:39427';
let backend;
let mainWindow;
let quitting = false;

async function start() {
  const appPath = app.getAppPath();
  const key = randomBytes(32).toString('hex');
  backend = utilityProcess.fork(path.join(appPath, 'server.cjs'), [], {
    cwd: appPath,
    env: {
      ...process.env,
      GITDIGEST_DESKTOP_KEY: key,
      GITDIGEST_DESKTOP_GIT: path.join(process.resourcesPath, 'git', 'cmd', 'git.exe'),
    },
  });

  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('The local ingestion engine did not start.')), 15000);
    backend.once('message', () => {
      clearTimeout(timer);
      resolve();
    });
    backend.once('exit', () => {
      clearTimeout(timer);
      if (quitting) return;
      const error = new Error('The local ingestion engine stopped. Check whether port 39427 is in use.');
      if (!mainWindow) return reject(error);
      showError(error);
    });
  });

  mainWindow = new BrowserWindow({
    width: 1280,
    height: 900,
    minWidth: 420,
    minHeight: 480,
    autoHideMenuBar: true,
    webPreferences: { preload: path.join(appPath, 'preload.cjs') },
  });
  const contents = mainWindow.webContents;
  const downloads = new Set();
  const trusted = (event) => event.senderFrame === contents.mainFrame && new URL(event.senderFrame.url).origin === origin;
  const credentialFile = path.join(app.getPath('userData'), 'github-token.enc');
  ipcMain.handle('read-token', async event => {
    if (!trusted(event)) throw new Error('Untrusted sender');
    try { return safeStorage.decryptString(await fs.readFile(credentialFile)); }
    catch (error) { if (error.code === 'ENOENT') return ''; throw error; }
  });
  ipcMain.handle('save-token', async (event, token) => {
    if (!trusted(event) || typeof token !== 'string' || token.length > 2560) throw new Error('Invalid credential request');
    if (!token) { await fs.rm(credentialFile, { force: true }); return; }
    if (!safeStorage.isEncryptionAvailable()) throw new Error('Secure storage unavailable');
    await fs.writeFile(credentialFile, safeStorage.encryptString(token));
  });
  ipcMain.handle('open-external', async (event, url) => {
    if (!trusted(event) || new URL(url).protocol !== 'https:') throw new Error('Invalid external link');
    await shell.openExternal(url);
  });
  ipcMain.handle('reveal-download', (event, file) => {
    if (!trusted(event) || !downloads.has(file)) throw new Error('Unknown download');
    shell.showItemInFolder(file);
  });
  contents.session.on('will-download', (_event, item, source) => {
    if (source !== contents) return;
    item.once('done', (_event, state) => {
      if (mainWindow.isDestroyed()) return;
      const success = state === 'completed';
      const savedPath = success ? item.getSavePath() : null;
      if (savedPath) downloads.add(savedPath);
      contents.send('download-finished', { success, path: savedPath });
    });
  });
  contents.session.webRequest.onBeforeSendHeaders({ urls: [`${origin}/*`] }, (details, callback) => {
    if (details.webContentsId === contents.id && new URL(details.url).origin === origin) {
      details.requestHeaders['X-GitDigest-Desktop'] = key;
    }
    callback({ requestHeaders: details.requestHeaders });
  });

  contents.on('will-navigate', (event, url) => {
    if (new URL(url).origin !== origin) event.preventDefault();
  });
  contents.setWindowOpenHandler(({ url }) => {
    if (new URL(url).protocol === 'https:') void shell.openExternal(url).catch(console.error);
    return { action: 'deny' };
  });

  ipcMain.handle('pick-local-path', async (event, kind) => {
    if (event.senderFrame !== contents.mainFrame || new URL(event.senderFrame.url).origin !== origin) return null;
    if (kind !== 'file' && kind !== 'folder') return null;
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: [kind === 'folder' ? 'openDirectory' : 'openFile'],
    });
    return result.canceled ? null : result.filePaths[0];
  });

  await mainWindow.loadURL(origin);
}

function showError(error) {
  dialog.showErrorBox('GitDigest', error.message);
  app.quit();
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow?.isMinimized()) mainWindow.restore();
    mainWindow?.focus();
  });
  app.on('window-all-closed', () => app.quit());
  app.on('before-quit', () => {
    quitting = true;
    backend?.kill();
  });
  app.whenReady().then(start).catch(showError);
}
