const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const {existsSync} = require('node:fs');
const {execFile} = require('node:child_process');
const {promisify} = require('node:util');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const {buildChromeArgs, chromeCandidates, validateProfile} = require('../src/core.cjs');
const {createDnsProbe, inspectDns, probeBrowser, withChromeProbe} = require('../src/diagnostics.cjs');
const {openProxy} = require('../src/network.cjs');

const chrome = chromeCandidates(process.platform, process.env, os.homedir()).find(file => existsSync(file));
const native = {skip: chrome ? false : 'Google Chrome Stable is not installed', timeout:60000};

test('DNS diagnostics distinguish a resolver event from a gateway-only sample', () => {
  const hostname = 'profile-desk-test.invalid';
  const constants = {logEventTypes:{HOST_RESOLVER_MANAGER_REQUEST:41, URL_REQUEST:11}};
  assert.match(inspectDns({constants, events:[{type:41, params:{host:hostname}}]}, hostname, false), /Possible local resolution/);
  assert.match(inspectDns({constants, events:[{type:11, params:{url:'http://' + hostname}}]}, hostname, true), /No matching Chrome resolver event/);
  assert.match(inspectDns({}, hostname, true), /Inconclusive/);
});

test('installed Chrome reports native privacy settings and loopback-only CDP overrides', native, async t => {
  const temp = await fs.realpath(os.tmpdir());
  const profile = validateProfile({
    name:'Browser sample', scheme:'http', host:'127.0.0.1', port:1,
    browserLanguage:'sk', preferredLanguages:'en-US', scaleFactor:1.5,
    webRtcPolicy:'disable_non_proxied_udp', locationPermission:'block', graphicsPrivacy:'block-both',
    qaUserAgent:'Profile Desk local QA', qaTimezone:'Europe/Bratislava', qaLatitude:48.15, qaLongitude:17.11
  });
  const dns = createDnsProbe();
  const gateway = await openProxy(profile, dns);
  t.after(gateway.close);
  const result = await probeBrowser(chrome, temp, profile, gateway, dns);
  assert.ok(dns.reachedGateway, 'Chrome sent the synthetic hostname to the local gateway');
  assert.match(result.dns, /No matching Chrome resolver event|Possible local resolution/);
  assert.match(result.native.userAgent, /Chrome/);
  assert.equal(result.native.languages[0], 'sk');
  assert.match(result.native.acceptLanguageHeader, /^sk/);
  assert.equal(result.native.scaleFactor, 1.5);
  assert.equal(result.native.locationPermission, 'denied');
  assert.equal(result.native.webgl, false);
  assert.equal(result.native.canvas, true);
  assert.equal(result.native.canvasReadback, false);
  assert.ok(result.native.ice);
  assert.equal(result.native.ice.udpCandidates, 0);
  assert.equal(result.qa.userAgent, 'Profile Desk local QA');
  assert.equal(result.qa.timeZone, 'Europe/Bratislava');
  assert.deepEqual(result.qa.location, [48.15,17.11]);
});

test('real Chrome preserves cookies across launches and separates profile directories', native, async t => {
  const root = await fs.realpath(os.tmpdir());
  const directory = await fs.mkdtemp(path.join(root, 'profile-desk-browser-test-'));
  t.after(async () => {
    if (path.dirname(directory) === root) await fs.rm(directory, {recursive:true, force:true, maxRetries:5, retryDelay:100});
  });
  const server = http.createServer((request, response) => {
    if (request.url === '/set') response.setHeader('Set-Cookie', 'local_test=value; Path=/; Max-Age=300; SameSite=Lax');
    response.end('<!doctype html><title>Local cookie fixture</title>');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => {server.close(resolve); server.closeAllConnections();}));
  const origin = 'http://127.0.0.1:' + server.address().port;
  const first = path.join(directory, 'first');
  const second = path.join(directory, 'second');
  const check = (profile, route, settings = {}) => withChromeProbe(chrome, profile, settings, {}, async ({navigate, evaluate}) => {
    assert.equal(await navigate(origin + route), true);
    return evaluate('document.cookie');
  });
  assert.equal(await check(first, '/set'), 'local_test=value');
  assert.equal(await check(first, '/read', {locationPermission:'block', browserLanguage:'sk'}), 'local_test=value');
  assert.equal(await check(second, '/read'), '');
});

test('a normal Chrome launch keeps requests off the direct route when its upstream is down', native, async t => {
  const root = await fs.realpath(os.tmpdir());
  const directory = await fs.mkdtemp(path.join(root, 'profile-desk-no-fallback-'));
  t.after(async () => {
    if (path.dirname(directory) === root) await fs.rm(directory, {recursive:true, force:true, maxRetries:5, retryDelay:100});
  });
  let requests = 0;
  const server = http.createServer((_request, response) => {
    requests++;
    response.end('<!doctype html><title>Local route fixture success</title>');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => {server.close(resolve); server.closeAllConnections();}));
  const url = 'http://127.0.0.1:' + server.address().port + '/';
  const gateway = await openProxy({scheme:'socks5', host:'127.0.0.1', port:1, username:'', password:''});
  t.after(gateway.close);
  const launch = (name, proxy) => promisify(execFile)(chrome, [
    '--headless', '--dump-dom', '--disable-background-networking',
    ...buildChromeArgs(path.join(directory, name), proxy, {startupUrls:[url]})
  ], {timeout:15000, windowsHide:true});

  assert.doesNotMatch((await launch('proxied', gateway.url)).stdout, /Local route fixture success/);
  assert.equal(requests, 0);
  assert.match((await launch('direct')).stdout, /Local route fixture success/);
  assert.ok(requests > 0);
});
