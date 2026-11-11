const {test} = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const net = require('node:net');
const {openProxy, checkIp} = require('../src/network.cjs');

async function serve(server) {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const sockets = new Set();
  server.on('connection', socket => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  return {
    port: server.address().port,
    close: () => new Promise(resolve => {
      for (const socket of sockets) socket.destroy();
      server.close(resolve);
    })
  };
}

test('checks exit IP through authenticated HTTP upstream and fails when that upstream drops', async t => {
  const origin = await serve(http.createServer((_request, response) => response.end('{"ip":"192.0.2.7"}')));
  t.after(origin.close);
  const upstream = http.createServer();
  let receivedAuthorization;
  upstream.on('connect', (request, socket, head) => {
    receivedAuthorization = request.headers['proxy-authorization'];
    if (receivedAuthorization !== 'Basic ' + Buffer.from('alex:secret').toString('base64')) {
      socket.end('HTTP/1.1 407 Proxy Authentication Required\r\n\r\n');
      return;
    }
    const target = net.connect(origin.port, '127.0.0.1', () => {
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) target.write(head);
      socket.pipe(target).pipe(socket);
    });
    target.on('error', () => socket.destroy());
    socket.once('close', () => target.destroy());
  });
  const server = await serve(upstream);
  t.after(server.close);
  const gateway = await openProxy({scheme:'http', host:'127.0.0.1', port:server.port, username:'alex', password:'secret'});
  t.after(gateway.close);
  const url = 'http://127.0.0.1:' + origin.port;
  assert.equal((await checkIp(gateway.url, url)).ip, '192.0.2.7');
  assert.ok(receivedAuthorization);
  await server.close();
  assert.equal((await checkIp(undefined, url)).ip, '192.0.2.7');
  await assert.rejects(checkIp(gateway.url, url), /proxy|connection/i);
});
