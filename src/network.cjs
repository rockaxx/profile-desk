const { performance } = require('node:perf_hooks');
const { isIP } = require('node:net');
const { Server } = require('proxy-chain');
const { Agent, ProxyAgent, request } = require('undici');
const { upstreamUrl } = require('./core.cjs');

const IP_CHECK_URL = 'https://api.ipify.org?format=json';
const IPV6_CHECK_URL = 'https://api6.ipify.org?format=json';

async function openProxy(profile, probe) {
  const upstream = upstreamUrl(profile);
  const server = new Server({
    host: '127.0.0.1',
    port: 0,
    prepareRequestFunction: ({hostname, isHttp}) => {
      if (probe && isHttp && hostname === probe.host) {
        probe.reachedGateway = true;
        return {customResponseFunction: () => ({statusCode: 200, body: 'Profile Desk DNS sample'})};
      }
      return {upstreamProxyUrl: upstream};
    }
  });
  await server.listen();
  return {url: 'http://127.0.0.1:' + server.port, close: () => server.close(true)};
}

async function checkIp(proxyUrl, endpoint = IP_CHECK_URL) {
  const dispatcher = proxyUrl ? new ProxyAgent(proxyUrl) : new Agent();
  const start = performance.now();
  try {
    const {statusCode, body} = await request(endpoint, {dispatcher, signal: AbortSignal.timeout(6500)});
    if (statusCode < 200 || statusCode >= 300) throw Error('The IP check service returned HTTP ' + statusCode + '.');
    const {ip} = await body.json();
    if (!isIP(ip)) throw Error('The IP check service did not return a valid address.');
    return {ip, duration: Math.round(performance.now() - start), checkedAt: new Date().toISOString()};
  } catch (error) {
    if (error.name === 'TimeoutError' || error.code === 'UND_ERR_CONNECT_TIMEOUT') {
      throw Error('The IP check timed out. Check the proxy address and upstream connection.');
    }
    const status = /(?:statusCode=|Proxy response \()(\d{3})/.exec(error.message)?.[1];
    if (status === '407' || status === '597') {
      throw Object.assign(Error('Proxy authentication failed. Check the username and password.'), {kind: 'auth'});
    }
    if (status) throw Error('The proxy rejected the connection (HTTP ' + status + '). Check its configuration.');
    if (error.code || error.cause) {
      throw Error('Could not establish the connection. Check the proxy host, port and protocol.');
    }
    throw error;
  } finally {
    await dispatcher.destroy();
  }
}

async function inspectRoute(profile, proxyUrl) {
  if (profile.scheme !== 'direct' && !proxyUrl) throw Error('The diagnostic proxy is unavailable.');
  const sample = async (url, family) => {
    try {
      const result = await checkIp(proxyUrl, url);
      if (isIP(result.ip) !== family) return {error: 'The service returned a different address family.'};
      return result;
    } catch (error) {
      return {error: error.message, kind: error.kind};
    }
  };
  const [ipv4, ipv6] = await Promise.all([sample(IP_CHECK_URL, 4), sample(IPV6_CHECK_URL, 6)]);
  let authentication = 'Direct connection';
  if (proxyUrl) {
    if (ipv4.ip || ipv6.ip) authentication = profile.username ? 'Connected with configured credentials' : 'Connected without configured credentials';
    else if (ipv4.kind === 'auth' || ipv6.kind === 'auth') authentication = 'Rejected';
    else authentication = 'Undetermined';
  }
  return {ipv4, ipv6, authentication};
}

module.exports = {openProxy, checkIp, inspectRoute, IP_CHECK_URL};
