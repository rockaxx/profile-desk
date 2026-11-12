const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { isIP } = require('node:net');

function chromeCandidates(platform, env, home) {
  if (platform === 'darwin') {
    const binary = 'Google Chrome.app/Contents/MacOS/Google Chrome';
    return [path.posix.join('/Applications', binary), path.posix.join(home, 'Applications', binary)];
  }
  if (platform === 'win32') {
    return [env.ProgramFiles, env['ProgramFiles(x86)'], env.LOCALAPPDATA]
      .filter(Boolean)
      .map(root => path.win32.join(root, 'Google', 'Chrome', 'Application', 'chrome.exe').replaceAll('\\', '/'));
  }
  return [];
}

const windowPresets = {
  desktop: [1280, 800],
  tablet: [820, 980],
  mobile: [430, 900]
};

function buildChromeArgs(directory, proxy, profile = {}) {
  const {startupUrls, windowPreset, windowWidth, windowHeight, scaleFactor, graphicsPrivacy} = validateAdvanced(profile);
  const size = windowPreset === 'custom' ? [windowWidth, windowHeight] : windowPresets[windowPreset];
  return [
    '--user-data-dir=' + directory,
    '--no-first-run',
    '--disable-background-mode',
    ...(proxy ? [
      '--proxy-server=' + proxy,
      '--proxy-bypass-list=<-loopback>'
    ] : ['--no-proxy-server']),
    ...(size ? ['--window-size=' + size.join(',')] : []),
    ...(scaleFactor ? ['--force-device-scale-factor=' + scaleFactor] : []),
    ...(['block-webgl', 'block-both'].includes(graphicsPrivacy) ? ['--disable-webgl'] : []),
    ...(['block-canvas-readback', 'block-both'].includes(graphicsPrivacy) ? ['--disable-reading-from-canvas'] : []),
    ...(startupUrls.length ? startupUrls : ['about:blank'])
  ];
}

function validateAdvanced(input) {
  const notes = typeof input.notes === 'string' ? input.notes.trim() : '';
  if (notes.length > 2000) throw Error('Profile notes can contain up to 2000 characters.');

  const raw = input.startupUrls ?? [];
  const lines = typeof raw === 'string' ? raw.split(/\r?\n/) : raw;
  if (!Array.isArray(lines) || lines.some(line => typeof line !== 'string')) {
    throw Error('Enter one HTTP or HTTPS startup tab URL per line.');
  }
  const urls = lines.map(line => line.trim()).filter(Boolean);
  if (urls.length > 10) throw Error('Enter up to 10 startup tabs.');
  const startupUrls = urls.map(value => {
    const url = URL.parse(value);
    if (!/^https?:\/\//i.test(value) || !url || url.username || url.password) {
      throw Error('Each startup tab must be an HTTP or HTTPS URL without credentials.');
    }
    if (url.href.length > 2048) throw Error('Each startup tab URL can contain up to 2048 characters after encoding.');
    return url.href;
  });

  const windowPreset = input.windowPreset ?? 'default';
  if (typeof windowPreset !== 'string' ||
    (windowPreset !== 'default' && windowPreset !== 'custom' && !Object.hasOwn(windowPresets, windowPreset))) {
    throw Error('Choose a valid window size.');
  }
  const windowWidth = windowPreset === 'custom' ? Number(input.windowWidth) : null;
  const windowHeight = windowPreset === 'custom' ? Number(input.windowHeight) : null;
  if (windowPreset === 'custom' && (
    !Number.isInteger(windowWidth) || windowWidth < 360 || windowWidth > 7680 ||
    !Number.isInteger(windowHeight) || windowHeight < 360 || windowHeight > 4320
  )) {
    throw Error('Window dimensions must be 360–7680 wide and 360–4320 high.');
  }
  return {notes, startupUrls, windowPreset, windowWidth, windowHeight, ...validatePrivacy(input)};
}

function validatePrivacy(input) {
  const choose = (key, options) => {
    const value = input[key] ?? options[0];
    if (!options.includes(value)) throw Error('Invalid value for ' + key + '.');
    return value;
  };
  const language = value => {
    if (!value) return '';
    try {
      return Intl.getCanonicalLocales(value)[0] ?? '';
    } catch {
      throw Error('Use valid language tags such as en-US or sk.');
    }
  };
  const browserLanguage = language(typeof input.browserLanguage === 'string' ? input.browserLanguage.trim() : '');
  const rawLanguages = input.preferredLanguages ?? [];
  const tags = Array.isArray(rawLanguages) ? rawLanguages : String(rawLanguages).split(',');
  if (tags.length > 12 || tags.some(tag => typeof tag !== 'string')) throw Error('Enter up to 12 preferred languages.');
  const preferredLanguages = [...new Set(tags.map(tag => language(tag.trim())).filter(Boolean))];
  const scaleFactor = optionalNumber(input.scaleFactor);
  if (scaleFactor !== null && (!Number.isFinite(scaleFactor) || scaleFactor < 0.5 || scaleFactor > 4)) {
    throw Error('Device scale factor must be between 0.5 and 4.');
  }
  const webRtcPolicy = choose('webRtcPolicy', ['chrome-default', 'default_public_interface_only', 'disable_non_proxied_udp']);
  const locationPermission = choose('locationPermission', ['chrome-default', 'ask', 'block']);
  const graphicsPrivacy = choose('graphicsPrivacy', ['chrome-default', 'block-webgl', 'block-canvas-readback', 'block-both']);
  const qaUserAgent = typeof input.qaUserAgent === 'string' ? input.qaUserAgent.trim() : '';
  if (!/^[\x20-\x7e]{0,512}$/.test(qaUserAgent)) throw Error('QA User-Agent must contain up to 512 printable ASCII characters.');
  const qaTimezone = typeof input.qaTimezone === 'string' ? input.qaTimezone.trim() : '';
  if (qaTimezone) {
    try {
      new Intl.DateTimeFormat('en', {timeZone: qaTimezone});
    } catch {
      throw Error('Enter a valid IANA time zone such as Europe/Bratislava.');
    }
    if (!/^[A-Za-z][A-Za-z0-9_+/-]{0,79}$/.test(qaTimezone)) throw Error('Enter an IANA time zone name.');
  }
  const qaLatitude = optionalNumber(input.qaLatitude);
  const qaLongitude = optionalNumber(input.qaLongitude);
  if ((qaLatitude !== null || qaLongitude !== null) && (
    qaLatitude === null || !Number.isFinite(qaLatitude) || Math.abs(qaLatitude) > 90 ||
    qaLongitude === null || !Number.isFinite(qaLongitude) || Math.abs(qaLongitude) > 180
  )) throw Error('Enter both coordinates in decimal degrees within latitude ±90 and longitude ±180.');
  return {browserLanguage, preferredLanguages, scaleFactor, webRtcPolicy, locationPermission, graphicsPrivacy,
    qaUserAgent, qaTimezone, qaLatitude, qaLongitude};
}

function optionalNumber(value) {
  return value == null || String(value).trim() === '' ? null : Number(value);
}

async function readJson(file) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return {};
    throw error;
  }
}

async function writeJson(file, value) {
  const temporary = file + '.profile-desk.tmp';
  await fs.writeFile(temporary, JSON.stringify(value), {mode: 0o600});
  await fs.rename(temporary, file);
}

async function applyChromePreferences(directory, input) {
  const {browserLanguage, preferredLanguages, webRtcPolicy, locationPermission} = validatePrivacy(input);
  const languages = [...new Set([browserLanguage, ...preferredLanguages].filter(Boolean))];
  const wanted = {
    'intl.selected_languages': languages.length ? languages.join(',') : undefined,
    'webrtc.ip_handling_policy': webRtcPolicy === 'chrome-default' ? undefined : webRtcPolicy,
    'profile.default_content_setting_values.geolocation': {ask:3, block:2}[locationPermission]
  };
  const journalFile = path.join(directory, 'profile-desk-preferences.json');
  const journal = await readJson(journalFile);
  if (Object.values(wanted).every(value => value === undefined) && !Object.keys(journal).length) return;

  const folder = path.join(directory, 'Default');
  await fs.mkdir(folder, {recursive:true});
  const prefsFile = path.join(folder, 'Preferences');
  const prefs = await readJson(prefsFile);
  const nextJournal = {};
  for (const [key, value] of Object.entries(wanted)) {
    const parts = key.split('.');
    const leaf = parts.pop();
    const parent = parts.reduce((object, part) => (object[part] ??= {}), prefs);
    const saved = journal[key];
    if (value !== undefined) {
      nextJournal[key] = saved ?? {present: Object.hasOwn(parent, leaf), value: parent[leaf]};
      parent[leaf] = value;
    } else if (saved) {
      if (saved.present) parent[leaf] = saved.value;
      else delete parent[leaf];
    }
  }
  await writeJson(journalFile, {...journal, ...nextJournal});
  await writeJson(prefsFile, prefs);
  await writeJson(journalFile, nextJournal);
}

function validateProfile(input) {
  const name = typeof input?.name === 'string' ? input.name.trim() : '';
  if (!name || name.length > 100) throw Error('Enter a profile name between 1 and 100 characters.');
  const scheme = input.scheme;
  const advanced = validateAdvanced(input);
  if (scheme === 'direct') return {name, scheme, host: '', port: null, username: '', password: '', ...advanced};
  if (!['http', 'https', 'socks5'].includes(scheme)) throw Error('Choose a proxy protocol.');
  const host = typeof input.host === 'string' ? input.host.trim() : '';
  if (!isIP(host) && !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/i.test(host)) {
    throw Error('Enter a proxy host without a URL scheme or path.');
  }
  const port = Number(input.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw Error('Enter a proxy port between 1 and 65535.');
  const username = typeof input.username === 'string' ? input.username : '';
  const password = typeof input.password === 'string' ? input.password : '';
  if (password && !username) throw Error('Enter the proxy username.');
  return {name, scheme, host, port, username, password, ...advanced};
}

function upstreamUrl(profile) {
  const { scheme, host, port, username, password } = profile;
  const address = isIP(host) === 6 ? '[' + host + ']' : host;
  const auth = username ? encodeURIComponent(username) + ':' + encodeURIComponent(password) + '@' : '';
  return scheme + '://' + auth + address + ':' + port;
}

function publicProfile({secret, ...profile}) {
  return {notes: '', startupUrls: [], windowPreset: 'default', preferredLanguages: [],
    webRtcPolicy: 'chrome-default', locationPermission: 'chrome-default', graphicsPrivacy: 'chrome-default',
    ...profile, hasPassword: Boolean(secret)};
}

class ProfileStore {
  constructor(root, crypto) {
    this.file = path.join(root, 'profiles.json');
    this.crypto = crypto;
    this.writes = Promise.resolve();
  }

  async read() {
    try {
      return JSON.parse(await fs.readFile(this.file, 'utf8'));
    } catch (error) {
      if (error.code === 'ENOENT') return [];
      throw error;
    }
  }

  async list() {
    return (await this.read()).map(publicProfile);
  }

  async get(id) {
    const row = (await this.read()).find(profile => profile.id === id);
    if (!row) throw Error('Profile not found.');
    return {...publicProfile(row), password: row.secret ? await this.crypto.decrypt(Buffer.from(row.secret, 'base64')) : ''};
  }

  save(input) {
    return this.change(async rows => {
      const {password, ...data} = validateProfile(input);
      const index = input.id ? rows.findIndex(row => row.id === input.id) : -1;
      if (input.id && index === -1) throw Error('Profile not found.');
      const previous = rows[index];
      const sameProxy = previous && ['scheme', 'host', 'port', 'username'].every(key => previous[key] === data[key]);
      const secret = password ? (await this.crypto.encrypt(password)).toString('base64') :
        (sameProxy && !input.clearPassword ? previous.secret : undefined);
      const profile = {
        ...data,
        id: previous?.id ?? randomUUID(),
        createdAt: previous?.createdAt ?? new Date().toISOString(),
        secret
      };
      if (previous) rows[index] = profile;
      else rows.push(profile);
      return publicProfile(profile);
    });
  }

  remove(id) {
    return this.change(rows => {
      const index = rows.findIndex(row => row.id === id);
      if (index === -1) throw Error('Profile not found.');
      rows.splice(index, 1);
      return true;
    });
  }

  change(update) {
    const task = this.writes.then(async () => {
      const rows = await this.read();
      const result = await update(rows);
      await fs.mkdir(path.dirname(this.file), {recursive: true});
      const temporary = this.file + '.tmp';
      await fs.writeFile(temporary, JSON.stringify(rows, null, 2), {mode: 0o600});
      await fs.rename(temporary, this.file);
      return result;
    });
    this.writes = task.catch(() => {});
    return task;
  }
}

module.exports = {buildChromeArgs, chromeCandidates, validateProfile, upstreamUrl, ProfileStore, applyChromePreferences};
