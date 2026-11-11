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

function buildChromeArgs(directory, proxy) {
  return [
    '--user-data-dir=' + directory,
    '--no-first-run',
    '--disable-background-mode',
    ...(proxy ? ['--proxy-server=' + proxy, '--proxy-bypass-list=<-loopback>'] : ['--no-proxy-server']),
    'about:blank'
  ];
}

function validateProfile(input) {
  const name = typeof input?.name === 'string' ? input.name.trim() : '';
  if (!name || name.length > 100) throw Error('Enter a profile name between 1 and 100 characters.');
  const scheme = input.scheme;
  if (scheme === 'direct') return {name, scheme, host: '', port: null, username: '', password: ''};
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
  return {name, scheme, host, port, username, password};
}

function upstreamUrl(profile) {
  const { scheme, host, port, username, password } = profile;
  const address = isIP(host) === 6 ? '[' + host + ']' : host;
  const auth = username ? encodeURIComponent(username) + ':' + encodeURIComponent(password) + '@' : '';
  return scheme + '://' + auth + address + ':' + port;
}

function publicProfile({secret, ...profile}) {
  return {...profile, hasPassword: Boolean(secret)};
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

module.exports = {buildChromeArgs, chromeCandidates, validateProfile, upstreamUrl, ProfileStore};
