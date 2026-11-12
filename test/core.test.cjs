const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { buildChromeArgs, chromeCandidates, validateProfile, upstreamUrl, ProfileStore, applyChromePreferences } = require('../src/core.cjs');

test('Chrome receives isolated data and a fixed proxy without a DIRECT fallback', () => {
  const args = buildChromeArgs('private/profile', 'http://127.0.0.1:41345');
  assert.ok(args.includes('--user-data-dir=private/profile'));
  assert.ok(args.includes('--proxy-server=http://127.0.0.1:41345'));
  assert.ok(args.includes('--proxy-bypass-list=<-loopback>'));
  assert.ok(!args.join(' ').includes('direct://'));
  assert.ok(!buildChromeArgs('private/other').some(arg => arg.startsWith('--proxy-server')));
});

test('resolves native Chrome paths on both target platforms', () => {
  assert.match(chromeCandidates('darwin', {}, '/Users/test')[0], /Google Chrome\.app\/Contents\/MacOS\/Google Chrome$/);
  assert.match(chromeCandidates('win32', { ProgramFiles: 'C:/Program Files' })[0], /Google\/Chrome\/Application\/chrome\.exe$/);
});

test('launches Chrome with startup tabs and physical window dimensions', () => {
  const settings = validateProfile({
    name: 'Mobile layout',
    scheme: 'direct',
    notes: 'Layout review',
    startupUrls: 'https://example.com/\nhttp://127.0.0.1:8000/preview',
    windowPreset: 'mobile'
  });
  const args = buildChromeArgs('private/layout', undefined, settings);
  assert.ok(args.includes('--window-size=430,900'));
  assert.deepEqual(args.slice(-2), ['https://example.com/', 'http://127.0.0.1:8000/preview']);
  assert.ok(!args.includes('about:blank'));
  assert.equal(settings.notes, 'Layout review');
  assert.equal(buildChromeArgs('private/default').at(-1), 'about:blank');
  assert.ok(buildChromeArgs('private/custom', undefined, {windowPreset:'custom', windowWidth:1024, windowHeight:768})
    .includes('--window-size=1024,768'));
});

test('rejects unsafe startup URLs and invalid custom dimensions', () => {
  const profile = {name: 'Test', scheme: 'direct'};
  for (const startupUrls of ['file:///tmp/document', '--disable-web-security', 'https://user:secret@example.com']) {
    assert.throws(() => validateProfile({...profile, startupUrls}), /startup tab/i);
  }
  assert.throws(() => buildChromeArgs('private/profile', undefined, {startupUrls: ['--disable-web-security']}), /startup tab/i);
  assert.throws(() => validateProfile({...profile, windowPreset: 'custom', windowWidth: 0, windowHeight: 768}), /window dimensions/i);
});

test('validates routing and URL-encodes SOCKS5 credentials', () => {
  assert.throws(() => validateProfile({name: 'Test', scheme: 'socks5', host: 'http://a.test', port: 1000}));
  assert.throws(() => validateProfile({name: 'Test', scheme: 'http', host: 'a.test', port: 65536}));
  const input = validateProfile({name: ' Test ', scheme: 'socks5', host: 'a.test', port: '1080', username: 'me@org', password: 'x:y#'});
  assert.equal(input.name, 'Test');
  assert.equal(upstreamUrl(input), 'socks5://me%40org:x%3Ay%23@a.test:1080');
  assert.equal(upstreamUrl({...input, host: '2001:db8::1'}), 'socks5://me%40org:x%3Ay%23@[2001:db8::1]:1080');
});

test('store serializes concurrent writes and excludes secrets from the renderer view', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'profile-desk-'));
  t.after(() => fs.rm(dir, {recursive: true, force: true}));
  const crypto = {
    encrypt: async text => Buffer.from(text).map(byte => byte ^ 31),
    decrypt: async buffer => buffer.map(byte => byte ^ 31).toString()
  };
  const store = new ProfileStore(dir, crypto);
  const [first, second] = await Promise.all([
    store.save({name:'Client A', scheme:'https', host:'proxy.test', port:8443, username:'alice', password:'SECRET-abc'}),
    store.save({name:'Client B', scheme:'direct'})
  ]);
  assert.notEqual(first.id, second.id);
  assert.equal(first.password, undefined);
  assert.equal(first.secret, undefined);
  assert.equal(first.hasPassword, true);
  assert.ok(!(await fs.readFile(path.join(dir, 'profiles.json'), 'utf8')).includes('SECRET-abc'));
  await store.save({...first, name:'Updated'});
  assert.equal((await store.get(first.id)).password, 'SECRET-abc');
  await store.save({...first, scheme:'direct'});
  assert.equal((await store.get(first.id)).password, '');
  assert.equal((await new ProfileStore(dir, crypto).list()).length, 2);
});

test('keeps advanced settings and defaults existing profiles on read', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'profile-desk-advanced-'));
  t.after(() => fs.rm(dir, {recursive: true, force: true}));
  await fs.writeFile(path.join(dir, 'profiles.json'), JSON.stringify([{id:'legacy', name:'Legacy', scheme:'direct'}]));
  const store = new ProfileStore(dir, {});
  assert.deepEqual((await store.get('legacy')).startupUrls, []);
  assert.equal((await store.get('legacy')).windowPreset, 'default');
  await store.save({
    id: 'legacy',
    name: 'Legacy',
    scheme: 'direct',
    notes: 'Example',
    startupUrls: 'https://example.com/',
    windowPreset: 'custom',
    windowWidth: 1024,
    windowHeight: 768
  });
  const [saved] = await new ProfileStore(dir, {}).list();
  assert.equal(saved.notes, 'Example');
  assert.deepEqual(saved.startupUrls, ['https://example.com/']);
  assert.equal(saved.windowWidth, 1024);
});

test('keeps local QA overrides out of regular launches and validates advanced values', () => {
  const profile = validateProfile({
    name:'QA', scheme:'direct', qaUserAgent:'ProfileDesk QA', qaTimezone:'Europe/Bratislava',
    browserLanguage:'sk-sk', preferredLanguages:'sk, en-us', scaleFactor:'1.5',
    webRtcPolicy:'disable_non_proxied_udp', locationPermission:'block', graphicsPrivacy:'block-webgl',
    qaLatitude:'48.15', qaLongitude:'17.11'
  });
  assert.deepEqual(profile.preferredLanguages, ['sk', 'en-US']);
  assert.equal(profile.browserLanguage, 'sk-SK');
  assert.equal(profile.qaLatitude, 48.15);
  const args = buildChromeArgs('private/profile', undefined, profile);
  assert.ok(args.includes('--force-device-scale-factor=1.5'));
  assert.ok(args.includes('--disable-webgl'));
  assert.ok(args.every(arg => !/ProfileDesk QA|Bratislava|remote-debugging/.test(arg)));
  assert.throws(() => validateProfile({...profile, qaTimezone:'Invalid/Zone'}), /time zone/i);
  assert.throws(() => validateProfile({...profile, qaLongitude:''}), /coordinates/i);
  assert.throws(() => validateProfile({...profile, qaUserAgent:'Invalid\r\nheader'}), /User-Agent/i);
});

test('applies Chrome preferences per profile and restores managed values only', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'profile-desk-prefs-'));
  t.after(() => fs.rm(dir, {recursive:true, force:true}));
  const first = path.join(dir, 'first');
  const second = path.join(dir, 'second');
  await fs.mkdir(path.join(first, 'Default'), {recursive:true});
  const prefs = path.join(first, 'Default', 'Preferences');
  await fs.writeFile(prefs, JSON.stringify({
    intl:{selected_languages:'de', untouched:true},
    profile:{content_settings:{exceptions:{geolocation:{sample:true}}}}
  }));
  await applyChromePreferences(first, {
    browserLanguage:'sk', preferredLanguages:['en-US'],
    webRtcPolicy:'disable_non_proxied_udp', locationPermission:'block'
  });
  const firstRead = JSON.parse(await fs.readFile(prefs, 'utf8'));
  assert.equal(firstRead.intl.selected_languages, 'sk,en-US');
  assert.equal(firstRead.webrtc.ip_handling_policy, 'disable_non_proxied_udp');
  assert.equal(firstRead.profile.default_content_setting_values.geolocation, 2);
  assert.equal(firstRead.profile.content_settings.exceptions.geolocation.sample, true);
  await applyChromePreferences(second, {webRtcPolicy:'default_public_interface_only'});
  const secondRead = JSON.parse(await fs.readFile(path.join(second, 'Default', 'Preferences'), 'utf8'));
  assert.equal(secondRead.webrtc.ip_handling_policy, 'default_public_interface_only');
  await applyChromePreferences(first, {});
  const restored = JSON.parse(await fs.readFile(prefs, 'utf8'));
  assert.equal(restored.intl.selected_languages, 'de');
  assert.equal(restored.intl.untouched, true);
  assert.equal(restored.webrtc.ip_handling_policy, undefined);
});
