const {test} = require('node:test');
const assert = require('node:assert/strict');
const {EventEmitter} = require('node:events');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {androidSdkRoots, androidQaUrl, createAndroidLauncher, androidSetupSpec, launchAndroidSetup, emulatorInputCommand} = require('../src/android.cjs');

const tools = {emulator:'emulator', adb:'adb'};
const stdout = value => ({stdout:value, stderr:''});

test('selects a fixed setup interpreter for supported hosts', () => {
  assert.deepEqual(androidSetupSpec('win32', 'x64'), {script:'setup-android.ps1', interpreter:'powershell'});
  assert.deepEqual(androidSetupSpec('darwin', 'arm64'), {script:'setup-android.command', interpreter:'bash'});
  assert.deepEqual(androidSetupSpec('darwin', 'x64'), {script:'setup-android.command', interpreter:'bash'});
  assert.equal(androidSetupSpec('linux', 'x64'), null);
  assert.equal(androidSetupSpec('win32', 'arm64'), null);
});

test('requires license consent and starts setup with piped output on both platforms', async t => {
  const root = await fs.realpath(os.tmpdir());
  const dir = await fs.mkdtemp(path.join(root, 'profile-desk-setup-test-'));
  t.after(() => fs.rm(dir, {recursive:true, force:true}));
  await assert.rejects(launchAndroidSetup(dir, {platform:'win32', arch:'x64'}), /Accept the Android SDK License/);
  assert.deepEqual(await fs.readdir(dir), []);
  let windows;
  await launchAndroidSetup(dir, {
    platform:'win32', arch:'x64', env:{SystemRoot:'C:\\Windows'},
    acceptLicense:true, enableHypervisor:true,
    start: (file, args, options) => {windows = {file,args,options};}
  });
  const staged = path.join(dir, 'android-setup');
  assert.ok(windows.args.includes('-NonInteractive'));
  assert.deepEqual(windows.args.slice(-3), [path.join(staged, 'setup-android.ps1'), '-AcceptSdkLicense', '-EnableHypervisor']);
  assert.equal(windows.options.windowsHide, true);
  assert.deepEqual(windows.options.stdio, ['ignore', 'pipe', 'pipe']);
  const contents = await fs.readFile(path.join(staged, 'setup-android.ps1'), 'utf8');
  assert.match(contents, /Get-VerifiedArchive/);
  let mac;
  await launchAndroidSetup(dir, {platform:'darwin', arch:'arm64', acceptLicense:true, start: (file, args, options) => {mac = {file,args,options};}});
  assert.equal(mac.file, '/bin/bash');
  assert.deepEqual(mac.args, [path.join(staged, 'setup-android.command'), '--accept-sdk-license']);
  assert.deepEqual(mac.options.stdio, ['ignore', 'pipe', 'pipe']);
  assert.match(await fs.readFile(mac.args[0], 'utf8'), /^#!\/bin\/bash/);
});

test('finds the conventional SDK locations on Windows and macOS', () => {
  assert.deepEqual(androidSdkRoots('win32', {ANDROID_HOME:'D:\\SDK', LOCALAPPDATA:'C:\\Users\\Me\\AppData\\Local'}, 'C:\\Users\\Me'), [
    'D:\\SDK', 'C:\\Users\\Me\\AppData\\Local\\Android\\Sdk'
  ]);
  assert.deepEqual(androidSdkRoots('darwin', {}, '/Users/me'), ['/Users/me/Library/Android/sdk']);
});

test('maps host loopback to the Android emulator and limits launch URLs to local QA', () => {
  assert.equal(androidQaUrl('http://localhost:5173/review?case=mobile'), 'http://10.0.2.2:5173/review?case=mobile');
  assert.equal(androidQaUrl('http://127.0.0.1:3000'), 'http://10.0.2.2:3000/');
  assert.equal(androidQaUrl(''), '');
  for (const value of ['https://example.com', 'file:///private', 'http://user:pass@localhost:3000', 'http://localhost:80@evil.test']) {
    assert.throws(() => androidQaUrl(value), /local QA URL/);
  }
});

test('boots the selected emulator, waits for Android, and targets its Chrome by ADB serial', async () => {
  const spawned = [];
  const actions = [];
  let running = false;
  let bootChecks = 0;
  const run = async (file, args) => {
    if (file === 'emulator') return stdout('QA_Phone\nQA_Tablet\n');
    assert.deepEqual(args.slice(0, 4), ['-H', 'localhost', '-P', '5037']);
    const command = args.slice(4);
    if (command[0] === 'devices') return stdout('List of devices attached\n' +
      'emulator-5554\tdevice\nusb123\tdevice\n' + (running ? 'emulator-5556\tdevice\n' : ''));
    if (command.includes('emu')) return stdout(command[1] === 'emulator-5554' ? 'QA_Tablet\nOK\n' : 'QA_Phone\nOK\n');
    assert.equal(command[1], 'emulator-5556');
    if (command.includes('getprop')) return stdout(++bootChecks > 1 ? '1\n' : '\n');
    if (command.includes('settings')) return stdout('null\n');
    if (command.includes('pm')) return stdout('package:/data/app/chrome/base.apk\n');
    actions.push(command);
    return stdout('Status: ok\n');
  };
  const start = (file, args) => {
    spawned.push([file, args]);
    running = true;
    const child = new EventEmitter();
    child.unref = () => {};
    process.nextTick(() => child.emit('spawn'));
    return child;
  };
  const launcher = createAndroidLauncher({run, start, pause: async () => {}});
  assert.deepEqual(await launcher.list(tools), ['QA_Phone', 'QA_Tablet']);
  const result = await launcher.open(tools, 'QA_Phone', "http://localhost:3000/O'Neil");
  assert.equal(result.serial, 'emulator-5556');
  assert.deepEqual(spawned, [['emulator', ['-avd', 'QA_Phone', '-no-window']]]);
  assert.equal(result.startedHere, true);
  assert.equal(actions.length, 1);
  assert.match(actions[0].at(-1), /com\.android\.chrome/);
  assert.ok(actions[0].at(-1).includes("O'\\''Neil"));
});

test('reuses the matching emulator and reports missing Chrome without opening another device', async () => {
  const launcher = createAndroidLauncher({
    run: async (file, args) => {
      if (file === 'emulator') return stdout('QA_Phone\n');
      if (args.includes('devices')) return stdout('List of devices attached\nemulator-5554\tdevice\n');
      if (args.includes('emu')) return stdout('QA_Phone\nOK\n');
      if (args.includes('getprop')) return stdout('1\n');
      if (args.includes('settings')) return stdout('null\n');
      if (args.includes('pm')) return stdout('');
      assert.fail('Chrome launch must not be attempted without the package');
    },
    start: () => assert.fail('Do not start a second instance')
  });
  const device = await launcher.open(tools, 'QA_Phone', '');
  assert.equal(device.startedHere, false);
  assert.match(device.warning, /Chrome.*not installed/);
  await assert.rejects(launcher.open(tools, '-wipe-data', ''), /Select an existing Android device/);
});

test('reports a bounded boot timeout', async () => {
  let clock = 0;
  const launcher = createAndroidLauncher({
    run: async (file, args) => file === 'emulator' ? stdout('QA_Phone\n') : stdout('List of devices attached\n'),
    start: () => {
      const child = new EventEmitter();
      child.unref = () => {};
      process.nextTick(() => child.emit('spawn'));
      return child;
    },
    pause: async () => { clock += 1000; },
    now: () => clock,
    timeoutMs: 2000
  });
  await assert.rejects(launcher.open(tools, 'QA_Phone', ''), /did not finish booting/);
});

test('configures the Android system proxy before launching a fresh Chrome IP check', async () => {
  let running = false;
  const starts = [];
  const commands = [];
  let configured = false;
  let mappingReady = true;
  const launcher = createAndroidLauncher({
    run: async (file, args) => {
      if (file === 'emulator') return stdout('QA_Phone\n');
      commands.push(args.slice(4));
      if (args.includes('devices')) return stdout(running ? 'emulator-5554\tdevice\n' : '');
      if (args.includes('kill')) {running = false; return stdout('OK\n');}
      if (args.includes('emu')) return stdout('QA_Phone\nOK\n');
      if (args.includes('getprop')) return stdout('1\n');
      if (args.includes('pm')) return stdout('package:/data/app/chrome/base.apk\n');
      if (args.includes('put')) configured = args.at(-1) === '127.0.0.1:38447';
      if (args.includes('get')) return stdout((configured ? {http_proxy:'127.0.0.1:38447\n', global_http_proxy_host:'127.0.0.1\n', global_http_proxy_port:'38447\n'}[args.at(-1)] : undefined) ?? 'null\n');
      if (args.includes('--list')) return stdout(mappingReady ? 'emulator-5554 tcp:38447 tcp:43123\n' : '');
      return stdout('Status: ok\n');
    },
    start: (file,args) => {
      starts.push([file,args]);
      running = true;
      const child = new EventEmitter();
      child.unref = () => {};
      process.nextTick(() => child.emit('spawn'));
      return child;
    }
  });
  const proxy = 'http://127.0.0.1:43123';
  await assert.rejects(launcher.open(tools,'QA_Phone','',{proxyUrl:'http://user:secret@example.test:8080'}), /local proxy adapter/i);
  const device = await launcher.open(tools,'QA_Phone','',{proxyUrl:proxy});
  assert.deepEqual(starts,[['emulator',['-avd','QA_Phone','-no-window','-no-snapshot']]]);
  const bind = commands.findIndex(args => args.includes('reverse') && args.includes('--no-rebind'));
  const configure = commands.findIndex(args => args.includes('put') && args.includes('127.0.0.1:38447'));
  const restart = commands.findIndex(args => args.includes('force-stop'));
  const launch = commands.findIndex(args => args.at(-1).includes('https://api.ipify.org?format=json&profile-desk='));
  assert.ok(bind >= 0 && bind < configure && configure < restart && restart < launch);
  assert.deepEqual(commands[bind].slice(-2), ['tcp:38447','tcp:43123']);
  await assert.rejects(launcher.open(tools,'QA_Phone','',{proxyUrl:proxy}), /Stop.*before applying its proxy/);
  await launcher.stop(tools, device);
  assert.ok(commands.some(args => args.includes('put') && args.includes(':0')));
  assert.ok(commands.some(args => args.includes('--remove') && args.includes('tcp:38447')));
  assert.equal(configured, false);
  commands.length = 0;
  mappingReady = false;
  await assert.rejects(launcher.open(tools,'QA_Phone','',{proxyUrl:proxy}), /did not establish the proxy tunnel/);
  assert.equal(running, false);
  assert.equal(commands.some(args => args.at(-1).startsWith('am start')), false);
});

test('checks actual emulator acceleration rather than assuming a restart is needed', async () => {
  const ready = createAndroidLauncher({run: async (file, args) => {
    assert.equal(file, 'emulator');
    assert.deepEqual(args, ['-accel-check']);
    return stdout('accel:\r\n0\r\nWHPX(10.0.26200) is installed and usable.\r\naccel\r\n');
  }});
  assert.equal(await ready.accelerationReady(tools), true);
  const blocked = createAndroidLauncher({run: async () => stdout('accel:\n12\nWHPX is not installed\naccel\n')});
  assert.equal(await blocked.accelerationReady(tools), false);
  const failed = createAndroidLauncher({run: async () => {throw Error('Emulator not available');}});
  assert.equal(await failed.accelerationReady(tools), false);
});

test('only accepts fixed Android input operations and quotes typed text', () => {
  assert.equal(emulatorInputCommand({kind:'tap', x:90, y:123}), 'input tap 90 123');
  assert.equal(emulatorInputCommand({kind:'swipe', x:90, y:123, endX:400, endY:600, duration:350}), 'input swipe 90 123 400 600 350');
  assert.equal(emulatorInputCommand({kind:'key', key:'back'}), 'input keyevent 4');
  assert.equal(emulatorInputCommand({kind:'text', text:"O'Neil test"}), "input text 'O'\\''Neil%stest'");
  assert.throws(() => emulatorInputCommand({kind:'tap', x:'1; echo bad', y:2}), /coordinates/i);
  assert.throws(() => emulatorInputCommand({kind:'shell', text:'am start'}), /Android input/i);
});

test('captures and stops only the selected emulator', async () => {
  const commands = [];
  let stopped = false;
  const png = Buffer.alloc(24);
  Buffer.from('89504e470d0a1a0a', 'hex').copy(png);
  png.write('IHDR', 12);
  png.writeUInt32BE(1080,16);
  png.writeUInt32BE(2400,20);
  const launcher = createAndroidLauncher({
    run: async (_file, args) => {
      const command = args.slice(4);
      commands.push(command);
      if (command.includes('devices')) return stdout(stopped ? 'List of devices attached\n' : 'emulator-5554\tdevice\n');
      if (command.includes('name')) return stdout('QA_Phone\nOK\n');
      if (command.includes('kill')) {stopped = true; return stdout('OK: killing emulator');}
      return stdout('');
    },
    capture: async (_file, args) => {
      assert.deepEqual(args.slice(4), ['-s','emulator-5554','exec-out','screencap','-p']);
      return {stdout:png};
    }
  });
  const phone = {avd:'QA_Phone',serial:'emulator-5554'};
  assert.match(await launcher.frame(tools,phone), /^data:image\/png;base64,/);
  await assert.rejects(launcher.stop(tools,{avd:'QA_Tablet',serial:'emulator-5554'}), /no longer belongs/);
  await launcher.input(tools, phone, {kind:'tap',x:80,y:90});
  await launcher.stop(tools,phone);
  assert.deepEqual(commands.filter(args=>args.includes('kill')), [['-s','emulator-5554','emu','kill']]);
});
