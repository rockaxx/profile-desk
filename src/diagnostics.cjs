const {spawn} = require('node:child_process');
const {randomUUID} = require('node:crypto');
const fs = require('node:fs/promises');
const http = require('node:http');
const path = require('node:path');
const {isIP} = require('node:net');
const {setTimeout: delay} = require('node:timers/promises');
const {applyChromePreferences, buildChromeArgs} = require('./core.cjs');

function startChrome(chrome, args) {
  const child = spawn(chrome, args, {
    stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'],
    windowsHide: true
  });
  const input = child.stdio[3];
  const output = child.stdio[4];
  const pending = new Map();
  let nextId = 0;
  let buffer = '';
  let closed = false;
  const exited = new Promise(resolve => child.once('close', () => {
    closed = true;
    resolve();
  }));
  const fail = () => {
    closed = true;
    for (const request of pending.values()) request.finish(Error('Chrome closed its diagnostic pipe.'));
  };
  child.on('error', fail);
  input.on('error', fail);
  output.on('error', fail);
  output.on('end', fail);
  output.setEncoding('utf8');
  output.on('data', chunk => {
    buffer += chunk;
    let delimiter;
    while ((delimiter = buffer.indexOf('\0')) >= 0) {
      const frame = buffer.slice(0, delimiter);
      buffer = buffer.slice(delimiter + 1);
      let reply;
      try { reply = JSON.parse(frame); } catch { fail(); return; }
      pending.get(reply.id)?.finish(reply.error ? Error(reply.error.message) : null, reply.result);
    }
  });
  const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    if (closed) return reject(Error('Chrome diagnostic pipe is closed.'));
    const id = ++nextId;
    const finish = (error, result) => {
      clearTimeout(timer);
      pending.delete(id);
      if (error) reject(error);
      else resolve(result);
    };
    const timer = setTimeout(() => finish(Error(method + ' timed out.')), 6000);
    pending.set(id, {finish});
    input.write(JSON.stringify({id, method, params, sessionId}) + '\0');
  });
  return {
    send,
    async close() {
      if (!closed) await send('Browser.close').catch(() => {});
      await Promise.race([exited, delay(2000)]);
      if (child.exitCode === null && child.signalCode === null) {
        child.kill();
        await Promise.race([exited, delay(2000)]);
      }
    }
  };
}

async function inspectPage() {
  const canvas = document.createElement('canvas');
  const context = canvas.getContext('2d');
  let canvasReadback = false;
  try {
    if (context) {
      context.getImageData(0, 0, 1, 1);
      canvas.toDataURL();
      canvasReadback = true;
    }
  } catch {}
  const result = {
    userAgent: navigator.userAgent,
    languages: Array.from(navigator.languages),
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    screen: [screen.width, screen.height],
    viewport: [innerWidth, innerHeight],
    scaleFactor: devicePixelRatio,
    canvas: Boolean(context),
    canvasReadback,
    webgl: Boolean(document.createElement('canvas').getContext('webgl2') || document.createElement('canvas').getContext('webgl')),
    locationPermission: 'unavailable'
  };
  try {
    result.locationPermission = (await navigator.permissions.query({name:'geolocation'})).state;
  } catch {}
  if (typeof RTCPeerConnection !== 'function') return {...result, ice: null};

  const peer = new RTCPeerConnection({iceServers: []});
  const candidates = [];
  try {
    peer.createDataChannel('profile-desk');
    const finished = new Promise(resolve => {
      peer.onicecandidate = ({candidate}) => {
        if (!candidate) return resolve(true);
        candidates.push({
          address: candidate.address || candidate.candidate.split(' ')[4] || '',
          protocol: candidate.protocol,
          type: candidate.type
        });
      };
    });
    await peer.setLocalDescription(await peer.createOffer());
    const complete = await Promise.race([finished, new Promise(resolve => setTimeout(() => resolve(false), 1800))]);
    return {...result, ice: {complete, candidates}};
  } finally {
    peer.close();
  }
}

function inspectDns(log, hostname, reachedGateway) {
  const resolverTypes = Object.entries(log.constants?.logEventTypes ?? {})
    .filter(([name]) => /^(HOST_RESOLVER|DNS_TRANSACTION)/.test(name))
    .map(([, type]) => type);
  const observed = log.events?.some(event => resolverTypes.includes(event.type) &&
    ['host', 'hostname', 'host_port_pair', 'query_name', 'qname'].some(key => {
      const value = event.params?.[key];
      return typeof value === 'string' && value.toLowerCase().includes(hostname);
    }));
  if (observed) return 'Chrome resolver activity observed for the test hostname. Possible local resolution.';
  if (reachedGateway && resolverTypes.length && Array.isArray(log.events)) {
    return 'Gateway received the test hostname. No matching Chrome resolver event in this sample.';
  }
  return 'Inconclusive. The Chrome NetLog and gateway did not confirm the test route.';
}

async function listenLocal() {
  const snapshot = {};
  const server = http.createServer((request, response) => {
    if (request.url === '/sample') {
      snapshot.userAgentHeader = request.headers['user-agent'];
      snapshot.acceptLanguageHeader = request.headers['accept-language'];
    }
    response.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Security-Policy': "default-src 'none'; base-uri 'none'; form-action 'none'"
    });
    response.end('<!doctype html><title>Profile Desk local diagnostics</title>');
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return {
    url: 'http://127.0.0.1:' + server.address().port,
    snapshot,
    close: () => new Promise(resolve => {
      server.close(resolve);
      server.closeAllConnections();
    })
  };
}

async function withChromeProbe(chrome, directory, profile, {gateway, netLog} = {}, action) {
  await applyChromePreferences(directory, profile);
  const args = buildChromeArgs(directory, gateway?.url, {...profile, startupUrls: []});
  if (gateway) args[args.indexOf('--proxy-bypass-list=<-loopback>')] = '--proxy-bypass-list=127.0.0.1';
  args.unshift('--headless', '--remote-debugging-pipe', '--disable-background-networking');
  if (netLog) args.unshift('--log-net-log=' + netLog);
  const browser = startChrome(chrome, args);
  try {
    const {targetId} = await browser.send('Target.createTarget', {url:'about:blank'});
    const {sessionId} = await browser.send('Target.attachToTarget', {targetId, flatten:true});
    const send = (method, params) => browser.send(method, params, sessionId);
    const evaluate = async expression => {
      const result = await send('Runtime.evaluate', {expression, awaitPromise:true, returnByValue:true});
      if (result.exceptionDetails) throw Error('Chrome could not evaluate the diagnostic page.');
      return result.result.value;
    };
    const navigate = async url => {
      const result = await send('Page.navigate', {url});
      if (result.errorText) return false;
      for (let attempt = 0; attempt < 30; attempt++) {
        if (await evaluate('location.href === ' + JSON.stringify(url) + ' && document.readyState === "complete"').catch(() => false)) return true;
        await delay(100);
      }
      return false;
    };
    return await action({browser, send, evaluate, navigate});
  } finally {
    await browser.close();
  }
}

async function probeBrowser(chrome, tempRoot, profile, gateway, dnsProbe) {
  const root = await fs.realpath(tempRoot);
  const directory = await fs.mkdtemp(path.join(root, 'profile-desk-diagnostics-'));
  const netLog = dnsProbe ? path.join(directory, 'netlog.json') : undefined;
  let site;
  try {
    site = await listenLocal();
    const sample = await withChromeProbe(chrome, directory, profile, {gateway, netLog}, async ({browser, send, evaluate, navigate}) => {
      // The synthetic hostname is reserved and the local gateway handles the response.
      if (dnsProbe) await navigate('http://' + dnsProbe.host + '/').catch(() => false);
      const url = site.url + '/sample';
      if (!await navigate(url)) throw Error('Chrome could not open the local diagnostic page.');
      const native = {...await evaluate('(' + inspectPage.toString() + ')()'), ...site.snapshot};
      const qa = {};
      const warnings = [];
      const apply = async (label, method, params) => {
        try {
          await send(method, params);
          return true;
        } catch {
          warnings.push(label + ' override was rejected by this Chrome build.');
          return false;
        }
      };
      if (profile.qaUserAgent && await apply('User-Agent', 'Emulation.setUserAgentOverride', {userAgent:profile.qaUserAgent})) {
        if (await navigate(url)) {
          qa.userAgent = await evaluate('navigator.userAgent');
          if (qa.userAgent !== profile.qaUserAgent || site.snapshot.userAgentHeader !== profile.qaUserAgent) {
            warnings.push('The UA observed by the local page or HTTP server differs from the requested value.');
          }
        }
        else warnings.push('The local page could not be reloaded after the User-Agent change.');
      }
      if (profile.qaTimezone && await apply('Time zone', 'Emulation.setTimezoneOverride', {timezoneId:profile.qaTimezone})) {
        qa.timeZone = await evaluate('Intl.DateTimeFormat().resolvedOptions().timeZone');
      }
      if (profile.qaLatitude != null && await apply('Geolocation', 'Emulation.setGeolocationOverride', {
        latitude: profile.qaLatitude, longitude: profile.qaLongitude, accuracy: 10
      })) {
        try {
          await browser.send('Browser.setPermission', {permission:{name:'geolocation'}, setting:'granted', origin:site.url});
          qa.location = await evaluate('new Promise(resolve => navigator.geolocation.getCurrentPosition(p => resolve([p.coords.latitude,p.coords.longitude]), () => resolve(null), {timeout:1500}))');
          if (!qa.location) warnings.push('The local page could not read the simulated position.');
        } catch {
          warnings.push('Chrome could not grant geolocation to the local diagnostic page.');
        }
      }
      if (profile.scaleFactor && Math.abs(native.scaleFactor - profile.scaleFactor) > 0.05) {
        warnings.push('The measured scale differs from the requested scale.');
      }
      if (['block-webgl', 'block-both'].includes(profile.graphicsPrivacy) && native.webgl) {
        warnings.push('WebGL remained available in the sample.');
      }
      if (['block-canvas-readback', 'block-both'].includes(profile.graphicsPrivacy) && native.canvasReadback) {
        warnings.push('Canvas readback remained available in the sample.');
      }
      if (profile.locationPermission === 'block' && native.locationPermission !== 'denied') {
        warnings.push('Geolocation did not report denied in the local sample.');
      }
      const preferred = profile.browserLanguage || profile.preferredLanguages?.[0];
      if (preferred && native.languages[0]?.toLowerCase() !== preferred.toLowerCase()) {
        warnings.push('Chrome reported a different primary language.');
      }
      if (profile.webRtcPolicy === 'disable_non_proxied_udp' && native.ice?.candidates.some(candidate => candidate.protocol === 'udp')) {
        warnings.push('The local WebRTC sample still exposed a UDP candidate.');
      }
      if (native.ice) {
        native.ice.numericAddresses = native.ice.candidates.filter(candidate => isIP(candidate.address)).length;
        native.ice.mdnsAddresses = native.ice.candidates.filter(candidate => candidate.address.endsWith('.local')).length;
        native.ice.udpCandidates = native.ice.candidates.filter(candidate => candidate.protocol === 'udp').length;
        if (gateway && native.ice.numericAddresses) warnings.push('WebRTC exposed numeric IP candidates in the proxied sample.');
        delete native.ice.candidates;
      }
      return {native, qa, warnings};
    });
    let dns = 'Direct connection. No proxy DNS comparison.';
    if (netLog) {
      try {
        dns = inspectDns(JSON.parse(await fs.readFile(netLog, 'utf8')), dnsProbe.host, dnsProbe.reachedGateway);
      } catch {
        dns = 'Inconclusive. Chrome did not produce a readable resolver log.';
      }
    }
    return {...sample, dns};
  } finally {
    await site?.close();
    if (path.dirname(directory) === root) await fs.rm(directory, {recursive:true, force:true, maxRetries:5, retryDelay:150});
  }
}

function createDnsProbe() {
  return {host: 'profile-desk-' + randomUUID() + '.invalid', reachedGateway: false};
}

module.exports = {createDnsProbe, inspectDns, probeBrowser, withChromeProbe};
