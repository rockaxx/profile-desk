const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { buildChromeArgs, chromeCandidates, validateProfile, upstreamUrl, ProfileStore } = require('../src/core.cjs');

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
