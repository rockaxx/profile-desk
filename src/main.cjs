const {app, BrowserWindow, ipcMain, safeStorage, shell} = require('electron');
const {spawn} = require('node:child_process');
const {once} = require('node:events');
const fs = require('node:fs/promises');
const path = require('node:path');
const {pathToFileURL} = require('node:url');
const {ProfileStore, buildChromeArgs, chromeCandidates, applyChromePreferences} = require('./core.cjs');
const {openProxy, checkIp, inspectRoute} = require('./network.cjs');
const {createDnsProbe, probeBrowser} = require('./diagnostics.cjs');
const {findAndroidTools, defaultAndroidUrl, createAndroidLauncher, androidSetupSpec, launchAndroidSetup} = require('./android.cjs');

const page = path.join(__dirname, 'index.html');
const active = new Map();
const busy = new Set();
const results = new Map();
const android = createAndroidLauncher();
let androidViewer;
let androidOpening;
const androidSetup = {status:'idle', log:'', restartRequired:false};
let setupUpdate;
let window;
let store;

async function findChrome() {
  for (const candidate of chromeCandidates(process.platform, process.env, app.getPath('home'))) {
    if (await fs.access(candidate).then(() => true, () => false)) return candidate;
  }
  return null;
}

function androidTools() {
  return findAndroidTools(process.platform, process.env, app.getPath('home'));
}

function publishAndroidSetup() {
  clearTimeout(setupUpdate);
  setupUpdate = undefined;
  if (window && !window.isDestroyed()) window.webContents.send('android:setup-progress', {...androidSetup});
}

function appendSetupOutput(chunk) {
  const cleaned = chunk.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/\r\n?/g, '\n');
  androidSetup.log = (androidSetup.log + cleaned).slice(-24000);
  if (androidSetup.log.includes('[PROFILE_DESK_RESTART_REQUIRED]')) androidSetup.restartRequired = true;
  if (!setupUpdate) setupUpdate = setTimeout(publishAndroidSetup, 120);
}

async function startAndroidSetup(options) {
  if (options?.acceptLicense !== true) throw Error('Accept the Android SDK License Agreement to continue.');
  if (androidSetup.status === 'running') throw Error('Android setup is already running.');
  Object.assign(androidSetup, {status:'running', log:'Starting Android setup…\n', restartRequired:false});
  publishAndroidSetup();
  let child;
  try {
    child = await launchAndroidSetup(app.getPath('userData'), {
      acceptLicense:true, enableHypervisor:options.enableHypervisor === true
    });
  } catch (error) {
    androidSetup.status = 'failed';
    appendSetupOutput(error.message + '\n');
    publishAndroidSetup();
    throw error;
  }
  for (const stream of [child.stdout, child.stderr]) {
    stream.setEncoding('utf8');
    stream.on('data', appendSetupOutput);
  }
  child.once('error', error => appendSetupOutput('Could not start the installer: ' + error.message + '\n'));
  child.once('close', (code, signal) => {
    androidSetup.status = code === 0 ? 'success' : 'failed';
    if (code !== 0) appendSetupOutput('\nInstaller exited (' + (code ?? signal ?? 'unknown') + ').\n');
    publishAndroidSetup();
    if (!window && process.platform !== 'darwin' && !active.size && !busy.size) app.quit();
  });
  return true;
}

async function androidProfile(id) {
  const profile = (await store.list()).find(item => item.id === id);
  if (!profile) throw Error('Profile not found.');
  return profile;
}

function viewerFor(id) {
  if (!androidViewer || androidViewer.id !== id) throw Error('Open Android for this profile first.');
  return androidViewer;
}

function describeAndroidViewer(viewer) {
  return {avd:viewer.device.avd, warning:viewer.device.warning, proxyIp:viewer.proxyIp};
}

async function stopAndroidViewer(viewer) {
  if (viewer.stopping) throw Error('Android is already stopping.');
  viewer.stopping = true;
  try {
    await android.stop(viewer.tools, viewer.device);
    if (androidViewer === viewer) androidViewer = undefined;
    await viewer.gateway?.close();
    return true;
  } finally {
    viewer.stopping = false;
  }
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

async function openProfile(id, phoneSize = false) {
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
    await applyChromePreferences(directory, profile);
    const settings = phoneSize ? {...profile, windowPreset:'mobile'} : profile;
    const child = spawn(chrome, buildChromeArgs(directory, gateway?.url, settings), {stdio: 'ignore', windowsHide: false});
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

async function diagnoseProfile(id) {
  const profile = await store.get(id);
  const chrome = await findChrome();
  const dnsProbe = profile.scheme === 'direct' ? undefined : createDnsProbe();
  const gateway = dnsProbe ? await openProxy(profile, dnsProbe) : null;
  try {
    const [route, browser] = await Promise.all([
      inspectRoute(profile, gateway?.url),
      chrome ? probeBrowser(chrome, app.getPath('temp'), profile, gateway, dnsProbe)
        .catch(error => ({error: error.message})) : {error:'Google Chrome Stable was not found.'}
    ]);
    if (route.ipv4.ip) results.set(id, route.ipv4);
    return {route, browser};
  } finally {
    await gateway?.close();
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
      hostOs: {darwin: 'macOS', win32: 'Windows', linux: 'Linux'}[process.platform] ?? process.platform,
      profiles: (await store.list()).map(profile => ({
        ...profile,
        running: active.has(profile.id),
        result: results.get(profile.id) ?? null
      }))
    }));
    register('profile:save', input => exclusive(input?.id ?? 'new', async () => {
      if (active.has(input?.id)) throw Error('Close the Chrome window before editing its profile.');
      if (input?.id && (androidOpening === input.id || androidViewer?.id === input.id)) throw Error('Stop Android before editing this profile.');
      const profile = await store.save(input);
      results.delete(profile.id);
      return profile;
    }));
    register('profile:remove', id => exclusive(id, async () => {
      if (active.has(id)) throw Error('Close the Chrome window before removing its profile.');
      if (androidOpening === id || androidViewer?.id === id) throw Error('Stop Android before removing this profile.');
      await store.remove(id);
      results.delete(id);
      return true;
    }));
    register('profile:open', id => exclusive(id, () => openProfile(id)));
    register('profile:open-phone-size', id => exclusive(id, () => openProfile(id, true)));
    register('profile:test', id => exclusive(id, () => testRoute(id)));
    register('profile:diagnose', id => exclusive(id, () => diagnoseProfile(id)));
    register('android:devices', async id => {
      const profile = await androidProfile(id);
      const tools = await androidTools();
      const setup = {...androidSetup};
      if (tools && setup.status !== 'running' && setup.restartRequired && await android.accelerationReady(tools)) {
        setup.restartRequired = false;
        androidSetup.restartRequired = false;
      }
      return {
        sdkReady: Boolean(tools),
        setupSupported: Boolean(androidSetupSpec(process.platform, process.arch)),
        devices: tools && androidSetup.status !== 'running' ? await android.list(tools) : [],
        setup,
        hypervisorOption: process.platform === 'win32',
        proxied: profile.scheme !== 'direct',
        viewer: androidViewer?.id === id ? describeAndroidViewer(androidViewer) : null,
        startupUrl: profile.scheme === 'direct' ? defaultAndroidUrl(profile.startupUrls) : ''
      };
    });
    register('android:open', async input => {
      const profile = await androidProfile(input?.id);
      if (androidSetup.status === 'running') throw Error('Wait for Android setup to finish.');
      if (androidOpening) throw Error('An Android device is already starting.');
      if (androidViewer) {
        if (androidViewer.id === profile.id && androidViewer.device.avd === input.avd && !androidViewer.stopping) {
          return describeAndroidViewer(androidViewer);
        }
        throw Error('Stop the Android session in its profile before opening another one.');
      }
      androidOpening = profile.id;
      let gateway;
      try {
        const tools = await androidTools();
        if (!tools) throw Error('Install Android Emulator and Android SDK Platform-Tools first.');
        const connection = await store.get(profile.id);
        if (connection.scheme !== 'direct' && input.url) throw Error('Clear the local QA URL or use a Direct profile.');
        if (connection.scheme !== 'direct') gateway = await openProxy(connection);
        const proxy = gateway ? await checkIp(gateway.url) : null;
        if (proxy) results.set(profile.id, proxy);
        const device = await android.open(tools, input.avd, input.url, {proxyUrl:gateway?.url});
        androidViewer = {id:profile.id, tools, device, gateway, proxyIp:proxy?.ip, stopping:false};
        return describeAndroidViewer(androidViewer);
      } finally {
        if (androidViewer?.gateway !== gateway) await gateway?.close().catch(() => {});
        androidOpening = undefined;
        broadcast();
        if (!window && process.platform !== 'darwin' && !active.size && !busy.size) app.quit();
      }
    });
    register('android:frame', id => {
      const viewer = viewerFor(id);
      if (viewer.stopping) throw Error('Android is stopping.');
      viewer.frame ??= android.frame(viewer.tools, viewer.device).finally(() => {viewer.frame = undefined;});
      return viewer.frame;
    });
    register('android:input', input => {
      const viewer = viewerFor(input?.id);
      if (viewer.stopping) throw Error('Android is stopping.');
      return android.input(viewer.tools, viewer.device, input.action);
    });
    register('android:stop', id => stopAndroidViewer(viewerFor(id)));
    register('android:setup', startAndroidSetup);
    register('android:license', () => shell.openExternal('https://developer.android.com/studio#terms-and-conditions').then(() => true));
    createWindow();
    app.on('activate', () => {if (!window) createWindow();});
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin' && !active.size && !busy.size && androidSetup.status !== 'running' && !androidOpening) app.quit();
  });
  app.on('before-quit', event => {
    if (!active.size && !busy.size && androidSetup.status !== 'running' && !androidOpening) {
      if (!androidViewer?.device.startedHere) return;
      event.preventDefault();
      if (!androidViewer.stopping) {
        stopAndroidViewer(androidViewer).then(() => app.quit()).catch(error => {
          if (!window) createWindow();
          window.show();
          window.webContents.send('workspace:quit-blocked', error.message);
        });
      }
      return;
    }
    event.preventDefault();
    if (!window) createWindow();
    window.show();
    window.webContents.send('workspace:quit-blocked', androidSetup.status === 'running' || androidOpening
      ? 'Android is starting or being installed. Wait before quitting.'
      : 'Close the active Chrome windows before quitting Profile Desk.');
  });
}
