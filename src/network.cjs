const { performance } = require('node:perf_hooks');
const { isIP } = require('node:net');
const { Server } = require('proxy-chain');
const { Agent, ProxyAgent, fetch } = require('undici');
const { upstreamUrl } = require('./core.cjs');

const IP_CHECK_URL = 'https://api.ipify.org?format=json';

async function openProxy(profile) {
  const server = new Server({
    host: '127.0.0.1',
    port: 0,
    prepareRequestFunction: () => ({upstreamProxyUrl: upstreamUrl(profile)})
  });
  await server.listen();
  return {url: 'http://127.0.0.1:' + server.port, close: () => server.close(true)};
}

async function checkIp(proxyUrl, endpoint = IP_CHECK_URL) {
  const dispatcher = proxyUrl ? new ProxyAgent(proxyUrl) : new Agent();
  const start = performance.now();
  try {
    const response = await fetch(endpoint, {dispatcher, signal: AbortSignal.timeout(6500)});
    if (!response.ok) throw Error('The IP check service returned HTTP ' + response.status + '.');
    const {ip} = await response.json();
    if (!isIP(ip)) throw Error('The IP check service did not return a valid address.');
    return {ip, duration: Math.round(performance.now() - start), checkedAt: new Date().toISOString()};
  } catch (error) {
    if (error.name === 'TimeoutError') throw Error('The IP check timed out. Check the proxy address and upstream connection.');
    if (error.cause) {
      const status = /statusCode=(\d+)/.exec(error.cause.message)?.[1];
      if (status === '407' || status === '597') throw Error('Proxy authentication failed. Check the username and password.');
      if (status) throw Error('The proxy rejected the connection (HTTP ' + status + '). Check its configuration.');
      throw Error('Could not establish the connection. Check the proxy host, port and protocol.');
    }
    throw error;
  } finally {
    await dispatcher.destroy();
  }
}

module.exports = {openProxy, checkIp, IP_CHECK_URL};
