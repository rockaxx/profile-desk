const {app, BrowserWindow, ipcMain, safeStorage} = require('electron');
const {spawn} = require('node:child_process');
const {once} = require('node:events');
const fs = require('node:fs/promises');
const path = require('node:path');
const {pathToFileURL} = require('node:url');
const {ProfileStore, buildChromeArgs, chromeCandidates} = require('./core.cjs');
const {openProxy, checkIp} = require('./network.cjs');

const page = path.join(__dirname, 'index.html');
const active = new Map();
const busy = new Set();
const results = new Map();
let window;
let store;

async function findChrome() {
  for (const candidate of chromeCandidates(process.platform, process.env, app.getPath('home'))) {
    if (await fs.access(candidate).then(() => true, () => false)) return candidate;
  }
  return null;
}

function broadcast() {
  if (window && !window.isDestroyed()) window.webContents.send('profiles:changed');
}

async function exclusive(id, action) {
  if (busy.has(id)) throw Error('This profile is already processing a request.');
  busy.add(id);
  try {
    return await action();
  } finally {
    busy.delete(id);
    broadcast();
  }
}

async function testRoute(id) {
  const profile = await store.get(id);
  const existing = active.get(id);
  const gateway = !existing && profile.scheme !== 'direct' ? await openProxy(profile) : null;
  try {
    const result = await checkIp(existing?.gateway?.url ?? gateway?.url);
    results.set(id, result);
    return result;
  } catch (error) {
    results.set(id, {error: error.message});
    throw error;
  } finally {
    await gateway?.close();
  }
}

async function openProfile(id) {
  if (active.has(id)) throw Error('This profile is already open.');
  const chrome = await findChrome();
  if (!chrome) throw Error('Install Google Chrome Stable in its standard location and try again.');
  const profile = await store.get(id);
  const directory = path.join(app.getPath('userData'), 'chrome-profiles', profile.id);
  const gateway = profile.scheme !== 'direct' ? await openProxy(profile) : null;
  try {
    if (gateway) {
      try {
        results.set(id, await checkIp(gateway.url));
      } catch (error) {
        results.set(id, {error: error.message});
        throw error;
      }
    }
    await fs.mkdir(directory, {recursive: true});
    const child = spawn(chrome, buildChromeArgs(directory, gateway?.url), {stdio: 'ignore', windowsHide: false});
    await once(child, 'spawn');
    active.set(id, {gateway});
    child.once('exit', () => {
      active.delete(id);
      gateway?.close().catch(() => {});
      broadcast();
    });
    return true;
  } catch (error) {
    await gateway?.close();
    throw error;
  }
}

function register(channel, handler) {
  ipcMain.handle(channel, async (event, input) => {
    if (event.sender !== window?.webContents || event.senderFrame?.url !== pathToFileURL(page).href) {
      throw Error('Invalid request origin.');
    }
    try {
      return {value: await handler(input)};
    } catch (error) {
      return {error: error.code ? 'Operation failed (' + error.code + ').' : error.message};
    }
  });
}

function createWindow() {
  window = new BrowserWindow({
    width: 1240,
    height: 810,
    minWidth: 740,
    minHeight: 620,
    show: false,
    backgroundColor: '#f3f4f0',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  window.webContents.setWindowOpenHandler(() => ({action: 'deny'}));
  window.webContents.on('will-navigate', event => event.preventDefault());
  window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  window.once('ready-to-show', () => window.show());
  window.on('closed', () => {window = null;});
  window.loadFile(page);
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!window) createWindow();
    if (window.isMinimized()) window.restore();
    window.focus();
  });

  app.whenReady().then(() => {
    app.setAppUserModelId('com.profiledesk.desktop');
    store = new ProfileStore(app.getPath('userData'), {
      encrypt: text => safeStorage.encryptStringAsync(text),
      decrypt: async buffer => (await safeStorage.decryptStringAsync(buffer)).result
    });

    register('workspace:read', async () => ({
      chrome: Boolean(await findChrome()),
      profiles: (await store.list()).map(profile => ({
        ...profile,
        running: active.has(profile.id),
        result: results.get(profile.id) ?? null
      }))
    }));
    register('profile:save', input => exclusive(input?.id ?? 'new', async () => {
      if (active.has(input?.id)) throw Error('Close the Chrome window before editing its profile.');
      const profile = await store.save(input);
      results.delete(profile.id);
      return profile;
    }));
    register('profile:remove', id => exclusive(id, async () => {
      if (active.has(id)) throw Error('Close the Chrome window before removing its profile.');
      await store.remove(id);
      results.delete(id);
      return true;
    }));
    register('profile:open', id => exclusive(id, () => openProfile(id)));
    register('profile:test', id => exclusive(id, () => testRoute(id)));
    createWindow();
    app.on('activate', () => {if (!window) createWindow();});
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin' && !active.size && !busy.size) app.quit();
  });
  app.on('before-quit', event => {
    if (!active.size && !busy.size) return;
    event.preventDefault();
    if (!window) createWindow();
    window.show();
    window.webContents.send('workspace:quit-blocked');
  });
}
