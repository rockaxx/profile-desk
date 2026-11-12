const {execFile, spawn} = require('node:child_process');
const {once} = require('node:events');
const {access, chmod, mkdir, readFile, rename, writeFile} = require('node:fs/promises');
const {X_OK} = require('node:fs').constants;
const {randomUUID} = require('node:crypto');
const path = require('node:path');
const {setTimeout: delay} = require('node:timers/promises');
const {promisify} = require('node:util');

const adbOptions = ['-H', 'localhost', '-P', '5037'];
const chromePackage = 'com.android.chrome';
const guestProxyPort = '38447';
const guestProxyAddress = '127.0.0.1:' + guestProxyPort;
const guestProxySocket = 'tcp:' + guestProxyPort;
const avdName = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const qaHosts = new Set(['localhost', '127.0.0.1', '10.0.2.2']);

function androidSetupSpec(platform, arch) {
  if (platform === 'win32' && arch === 'x64') return {script:'setup-android.ps1', interpreter:'powershell'};
  if (platform === 'darwin' && ['x64', 'arm64'].includes(arch)) return {script:'setup-android.command', interpreter:'bash'};
  return null;
}

async function launchAndroidSetup(userData, {
  platform = process.platform, arch = process.arch, env = process.env, start = spawn,
  acceptLicense = false, enableHypervisor = false
} = {}) {
  if (!acceptLicense) throw Error('Accept the Android SDK License Agreement to continue.');
  const setup = androidSetupSpec(platform, arch);
  if (!setup) throw Error('Android setup supports Windows x64 and macOS.');
  const folder = path.join(userData, 'android-setup');
  await mkdir(folder, {recursive:true, mode:0o700});
  const script = path.join(folder, setup.script);
  const temporary = path.join(folder, randomUUID() + '.tmp');
  await writeFile(temporary, await readFile(path.join(__dirname, setup.script)), {mode:0o700});
  await rename(temporary, script);
  const options = {stdio:['ignore', 'pipe', 'pipe'], windowsHide:true, cwd:folder};
  if (setup.interpreter === 'bash') {
    await chmod(script, 0o700);
    return start('/bin/bash', [script, '--accept-sdk-license'], options);
  }

  const powershell = path.join(env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, '-AcceptSdkLicense'];
  if (enableHypervisor) args.push('-EnableHypervisor');
  return start(powershell, args, options);
}

function androidSdkRoots(platform, env, home) {
  const candidates = [env.ANDROID_HOME, env.ANDROID_SDK_ROOT];
  if (platform === 'win32') {
    const local = env.LOCALAPPDATA || path.win32.join(home, 'AppData', 'Local');
    candidates.push(path.win32.join(local, 'Android', 'Sdk'));
  }
  if (platform === 'darwin') candidates.push(path.posix.join(home, 'Library', 'Android', 'sdk'));
  return [...new Set(candidates.filter(Boolean))];
}

async function findAndroidTools(platform, env, home) {
  const suffix = platform === 'win32' ? '.exe' : '';
  const roots = androidSdkRoots(platform, env, home);
  const standard = androidSdkRoots(platform, {LOCALAPPDATA:env.LOCALAPPDATA}, home)[0];
  if (standard && await access(path.join(standard, '.profile-desk-android-ready')).then(() => true, () => false)) {
    roots.splice(roots.indexOf(standard), 1);
    roots.unshift(standard);
  }
  for (const root of roots) {
    const emulator = path.join(root, 'emulator', 'emulator' + suffix);
    const adb = path.join(root, 'platform-tools', 'adb' + suffix);
    const found = await Promise.all([access(emulator, X_OK), access(adb, X_OK)]).then(() => true, () => false);
    if (found) return {emulator, adb, root};
  }
  return null;
}

function androidQaUrl(input) {
  if (typeof input !== 'string') throw Error('Enter a local QA URL.');
  const value = input.trim();
  if (!value) return '';
  const url = URL.parse(value);
  if (!url || !/^https?:\/\//i.test(value) || !qaHosts.has(url.hostname) || url.username || url.password) {
    throw Error('Enter a local QA URL using localhost, 127.0.0.1 or 10.0.2.2.');
  }
  url.hostname = '10.0.2.2';
  if (url.href.length > 2048) throw Error('The local QA URL exceeds 2048 characters.');
  return url.href;
}

function defaultAndroidUrl(startupUrls = []) {
  for (const value of startupUrls) {
    try {
      const url = androidQaUrl(value);
      if (url) return url;
    } catch {}
  }
  return '';
}

function shellQuote(value) {
  return "'" + value.replaceAll("'", "'\\''") + "'";
}

function runTool(file, args, timeout = 8000, env = process.env) {
  return promisify(execFile)(file, args, {timeout, env, windowsHide:true, maxBuffer:128 * 1024});
}

function captureScreen(file, args, env) {
  return promisify(execFile)(file, args, {encoding:'buffer', timeout:6500, env, windowsHide:true, maxBuffer:12 * 1024 * 1024});
}

function startEmulator(file, args, env) {
  return spawn(file, args, {detached:process.platform !== 'win32', env, stdio:'ignore', windowsHide:true});
}

function emulatorInputCommand(action) {
  const coordinate = number => {
    if (!Number.isInteger(number) || number < 0 || number > 8191) throw Error('Invalid Android coordinates.');
    return number;
  };
  if (action?.kind === 'tap') return 'input tap ' + coordinate(action.x) + ' ' + coordinate(action.y);
  if (action?.kind === 'swipe') {
    if (!Number.isInteger(action.duration) || action.duration < 80 || action.duration > 1500) {
      throw Error('Invalid Android swipe duration.');
    }
    return 'input swipe ' + [action.x, action.y, action.endX, action.endY].map(coordinate).join(' ') + ' ' + action.duration;
  }
  if (action?.kind === 'key') {
    const keys = {back:4, home:3, enter:66, backspace:67};
    if (typeof action.key === 'string' && Object.hasOwn(keys, action.key)) return 'input keyevent ' + keys[action.key];
  }
  if (action?.kind === 'text') {
    if (typeof action.text !== 'string' || !/^[\x20-\x7e]{1,200}$/.test(action.text) || action.text.includes('%s')) {
      throw Error('Enter up to 200 ASCII characters. Use the Android keyboard for other text.');
    }
    return 'input text ' + shellQuote(action.text.replaceAll(' ', '%s'));
  }
  throw Error('Invalid Android input.');
}

function createAndroidLauncher({run = runTool, start = startEmulator, capture = captureScreen, pause = delay, now = Date.now, timeoutMs = 150000} = {}) {
  const busy = new Set();
  const sdkEnv = tools => tools.root ? {...process.env, ANDROID_HOME:tools.root, ANDROID_SDK_ROOT:tools.root} : process.env;

  async function list(tools) {
    try {
      const {stdout} = await run(tools.emulator, ['-list-avds'], undefined, sdkEnv(tools));
      return [...new Set(stdout.split(/\r?\n/).map(name => name.trim()).filter(name => avdName.test(name)))];
    } catch {
      throw Error('Android Emulator could not list devices. Check the SDK installation and run Device Manager.');
    }
  }

  const adb = (tools, args, timeout) => run(tools.adb, [...adbOptions, ...args], timeout, sdkEnv(tools));

  async function accelerationReady(tools) {
    try {
      const {stdout} = await run(tools.emulator, ['-accel-check'], undefined, sdkEnv(tools));
      return /^accel:\s*0(?:\s|$)/m.test(stdout);
    } catch {
      return false;
    }
  }

  async function deviceList(tools) {
    try {
      return (await adb(tools, ['devices'])).stdout;
    } catch {
      throw Error('Local ADB is unavailable. Check Android SDK Platform-Tools.');
    }
  }

  async function deviceName(tools, serial) {
    const {stdout} = await adb(tools, ['-s', serial, 'emu', 'avd', 'name']);
    return stdout.split(/\r?\n/)[0].trim();
  }

  async function findDevice(tools, avd) {
    const devices = await deviceList(tools);
    const serials = Array.from(devices.matchAll(/^(emulator-\d+)[ \t]+device[ \t\r]*$/gm), match => match[1]);
    const matches = await Promise.all(serials.map(async serial => {
      try {
        return await deviceName(tools, serial) === avd ? serial : null;
      } catch {
        return null;
      }
    }));
    return matches.find(Boolean);
  }

  async function bootDevice(tools, avd, proxyUrl) {
    let serial = await findDevice(tools, avd);
    if (serial && proxyUrl) throw Error('Stop the running Android device before applying its proxy.');
    const startedHere = !serial;
    let earlyExit;
    if (!serial) {
      const args = ['-avd', avd, '-no-window'];
      if (proxyUrl) args.push('-no-snapshot');
      const child = start(tools.emulator, args, {...sdkEnv(tools), http_proxy:'', HTTP_PROXY:''});
      child.once('exit', (code, signal) => {earlyExit = code ?? signal ?? 'unknown';});
      try {
        await once(child, 'spawn');
      } catch {
        throw Error('Android Emulator could not start. Open the device in Android Studio to see the error.');
      }
      child.unref();
    }
    const deadline = now() + timeoutMs;
    while (now() < deadline) {
      serial ??= await findDevice(tools, avd);
      if (serial) {
        const state = await adb(tools, ['-s', serial, 'shell', 'getprop', 'sys.boot_completed']).catch(() => null);
        if (state?.stdout.trim() === '1') return {avd, serial, startedHere};
        // Rediscover the device if ADB lost it during boot.
        if (!state) serial = undefined;
      }
      if (!serial && earlyExit !== undefined) {
        throw Error('Android Emulator exited before connecting to ADB (' + earlyExit + '). Open it in Android Studio to see the error.');
      }
      await pause(1200);
    }
    throw Error('Android did not finish booting in time. Let the emulator finish starting and try again.');
  }

  const getProxySetting = async (tools, serial, key) =>
    (await adb(tools, ['-s', serial, 'shell', 'settings', 'get', 'global', key])).stdout.trim();

  async function clearManagedProxy(tools, serial) {
    if (await getProxySetting(tools, serial, 'http_proxy') !== guestProxyAddress) return;
    await adb(tools, ['-s', serial, 'shell', 'am', 'force-stop', chromePackage]);
    await adb(tools, ['-s', serial, 'shell', 'settings', 'put', 'global', 'http_proxy', ':0']);
    await adb(tools, ['-s', serial, 'reverse', '--remove', guestProxySocket]).catch(() => {});
  }

  async function configureBrowserProxy(tools, serial, port) {
    const previous = await Promise.all(['http_proxy', 'global_http_proxy_host', 'global_http_proxy_pac']
      .map(key => getProxySetting(tools, serial, key)));
    const absent = value => ['', 'null', ':0'].includes(value);
    if (!previous.every(absent) && (previous[0] !== guestProxyAddress || !absent(previous[2]))) {
      throw Error('The virtual device already has an Android system proxy. Remove it or choose a different device.');
    }
    const hostSocket = 'tcp:' + port;
    await adb(tools, ['-s', serial, 'reverse', '--no-rebind', guestProxySocket, hostSocket]);
    const {stdout} = await adb(tools, ['-s', serial, 'reverse', '--list']);
    if (!stdout.split(/\r?\n/).some(line => line.trim().split(/\s+/).slice(-2).join(' ') === guestProxySocket + ' ' + hostSocket)) {
      throw Error('Android did not establish the proxy tunnel.');
    }
    await adb(tools, ['-s', serial, 'shell', 'settings', 'put', 'global', 'http_proxy', guestProxyAddress]);
    for (let attempt = 0; attempt < 8; attempt++) {
      const [host, proxyPort] = await Promise.all(['global_http_proxy_host', 'global_http_proxy_port']
        .map(key => getProxySetting(tools, serial, key)));
      if (host === '127.0.0.1' && proxyPort === guestProxyPort) {
        await adb(tools, ['-s', serial, 'shell', 'am', 'force-stop', chromePackage]);
        return;
      }
      await pause(250);
    }
    throw Error('Android did not apply the browser proxy. Chrome was not opened.');
  }

  async function open(tools, avd, input, {proxyUrl} = {}) {
    const proxy = proxyUrl && /^http:\/\/127\.0\.0\.1:(\d{1,5})$/.exec(proxyUrl);
    if (proxyUrl && (!proxy || Number(proxy[1]) < 1 || Number(proxy[1]) > 65535)) {
      throw Error('Android requires a valid local proxy adapter.');
    }
    const url = proxy ? 'https://api.ipify.org?format=json&profile-desk=' + randomUUID() : androidQaUrl(input);
    if (typeof avd !== 'string' || !avdName.test(avd)) throw Error('Select an existing Android device.');
    if (busy.has(avd)) throw Error('This Android device is already starting.');
    busy.add(avd);
    try {
      if (!(await list(tools)).includes(avd)) throw Error('Select an existing Android device.');
      const device = await bootDevice(tools, avd, proxyUrl);
      const {serial} = device;
      if (proxy) {
        device.browserProxy = true;
        try {
          await configureBrowserProxy(tools, serial, proxy[1]);
        } catch (error) {
          await stop(tools, device).catch(() => {});
          throw error;
        }
      } else {
        await clearManagedProxy(tools, serial);
      }
      const packageCheck = await adb(tools, ['-s', serial, 'shell', 'pm', 'path', chromePackage]).catch(() => null);
      if (!packageCheck) return {...device, warning:'Could not check Chrome. Open it manually in Android.'};
      if (!/^package:/m.test(packageCheck.stdout)) {
        return {...device, warning:'Google Chrome is not installed. Install it on this Android device.'};
      }
      const intent = url
        ? 'am start -W -a android.intent.action.VIEW -d ' + shellQuote(url) + ' -p ' + chromePackage
        : 'am start -W -a android.intent.action.MAIN -c android.intent.category.LAUNCHER -p ' + chromePackage;
      let result;
      try {
        result = await adb(tools, ['-s', serial, 'shell', intent], 20000);
      } catch {
        return {...device, warning:'ADB could not start Chrome. Open it manually in Android.'};
      }
      if (!/^Status:\s*ok\s*$/mi.test(result.stdout) ||
        /(?:^Error:|Exception|unable to resolve Intent)/mi.test(result.stdout + result.stderr)) {
        return {...device, warning:'Android could not open Chrome. Complete Chrome setup on the device.'};
      }
      return device;
    } finally {
      busy.delete(avd);
    }
  }

  function validDevice(device) {
    if (!device || typeof device.serial !== 'string' || !/^emulator-\d+$/.test(device.serial) ||
      typeof device.avd !== 'string' || !avdName.test(device.avd)) throw Error('Select a connected Android emulator.');
  }

  async function verifyDevice(tools, device) {
    validDevice(device);
    const actual = await deviceName(tools, device.serial).catch(() => '');
    if (actual !== device.avd) throw Error('The ADB serial no longer belongs to the selected Android device.');
  }

  async function frame(tools, device) {
    await verifyDevice(tools, device);
    const {stdout} = await capture(tools.adb, [...adbOptions, '-s', device.serial, 'exec-out', 'screencap', '-p'], sdkEnv(tools));
    if (!Buffer.isBuffer(stdout) || stdout.length < 24 || stdout.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a' ||
      stdout.toString('ascii',12,16) !== 'IHDR') throw Error('Android did not return a valid screen image.');
    return 'data:image/png;base64,' + stdout.toString('base64');
  }

  async function input(tools, device, action) {
    const command = emulatorInputCommand(action);
    await verifyDevice(tools, device);
    await adb(tools, ['-s', device.serial, 'shell', command]);
    return true;
  }

  async function stop(tools, device) {
    validDevice(device);
    const connected = async () => (await deviceList(tools)).split(/\r?\n/).some(line => line.split(/\s+/)[0] === device.serial);
    if (!await connected()) return true;
    await verifyDevice(tools, device);
    if (device.browserProxy) await clearManagedProxy(tools, device.serial).catch(() => {});
    const result = await adb(tools, ['-s', device.serial, 'emu', 'kill']);
    if (/^KO:/m.test(result.stdout)) throw Error('Android Emulator refused the stop command.');
    const deadline = now() + 15000;
    while (now() < deadline) {
      if (!await connected()) return true;
      await pause(450);
    }
    throw Error('Android Emulator is still shutting down. Try again in a moment.');
  }

  return {list, open, accelerationReady, frame, input, stop};
}

module.exports = {androidSdkRoots, findAndroidTools, androidQaUrl, defaultAndroidUrl, createAndroidLauncher,
  androidSetupSpec, launchAndroidSetup, emulatorInputCommand};
