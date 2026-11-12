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
  const rejected = await openProxy({scheme:'http', host:'127.0.0.1', port:server.port, username:'alex', password:'wrong'});
  t.after(rejected.close);
  await assert.rejects(checkIp(rejected.url, url), {kind:'auth'});
  await server.close();
  assert.equal((await checkIp(undefined, url)).ip, '192.0.2.7');
  await assert.rejects(checkIp(gateway.url, url), /proxy|connection/i);
});

test('preserves authenticated SOCKS5 connections and reports rejected credentials', async t => {
  const origin = await serve(http.createServer((_request, response) => response.end('{"ip":"192.0.2.8"}')));
  t.after(origin.close);
  const upstream = net.createServer(socket => {
    let phase = 'methods';
    let buffer = Buffer.alloc(0);
    const read = chunk => {
      buffer = Buffer.concat([buffer, chunk]);
      if (phase === 'methods') {
        if (buffer.length < 2 || buffer.length < 2 + buffer[1]) return;
        buffer = buffer.subarray(2 + buffer[1]);
        phase = 'credentials';
        socket.write(Buffer.from([5, 2]));
        return;
      }
      if (phase === 'credentials') {
        if (buffer.length < 2 || buffer.length < 3 + buffer[1]) return;
        const usernameEnd = 2 + buffer[1];
        const end = usernameEnd + 1 + buffer[usernameEnd];
        if (buffer.length < end) return;
        const accepted = buffer.toString('utf8', 2, usernameEnd) === 'alex' &&
          buffer.toString('utf8', usernameEnd + 1, end) === 'secret';
        if (!accepted) return socket.end(Buffer.from([1, 1]));
        buffer = buffer.subarray(end);
        phase = 'connect';
        socket.write(Buffer.from([1, 0]));
        return;
      }
      if (buffer.length < 10) return;
      socket.removeListener('data', read);
      const target = net.connect(origin.port, '127.0.0.1', () => {
        socket.write(Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 0]));
        socket.pipe(target).pipe(socket);
      });
      target.on('error', () => socket.destroy());
      socket.once('close', () => target.destroy());
    };
    socket.on('data', read);
  });
  const server = await serve(upstream);
  t.after(server.close);
  const url = 'http://127.0.0.1:' + origin.port;
  const options = {scheme:'socks5', host:'127.0.0.1', port:server.port, username:'alex'};
  const accepted = await openProxy({...options, password:'secret'});
  const rejected = await openProxy({...options, password:'wrong'});
  t.after(accepted.close);
  t.after(rejected.close);
  assert.equal((await checkIp(accepted.url, url)).ip, '192.0.2.8');
  await assert.rejects(checkIp(rejected.url, url), {kind:'auth'});
});
