const http = require('http');
const net = require('net');
const stream = require('stream');
const util = require('util');
const EventEmitter = require('events');

const P = Object.getPrototypeOf;
const label = new Map([
  [stream.Readable.prototype, 'Readable'],
  [stream.Stream.prototype, 'Stream'],
  [EventEmitter.prototype, 'EventEmitter'],
  [net.Server.prototype, 'net.Server'],
  [http.OutgoingMessage.prototype, 'OutgoingMessage'],
  [Object.prototype, 'Object'],
]);
for (const name of ['IncomingMessage', 'OutgoingMessage', 'ServerResponse', 'ClientRequest', 'Server', 'Agent']) {
  const C = http[name];
  const chain = [];
  for (let p = P(C.prototype); p; p = P(p)) chain.push(label.get(p) ?? '?');
  const classSyntax = /^class\b/.test(Function.prototype.toString.call(C));
  console.log(`${name}: name=${C.name} length=${C.length} class=${classSyntax} chain=${chain.join('>')}`);
}
const methods = {
  IncomingMessage: ['setTimeout', '_read', '_destroy', '_dump'],
  OutgoingMessage: ['setHeader', 'appendHeader', 'setHeaders', 'getHeader', 'getHeaders', 'getHeaderNames', 'getRawHeaderNames', 'hasHeader', 'removeHeader', 'write', 'end', 'destroy', 'flushHeaders', 'addTrailers', 'cork', 'uncork', 'pipe', 'setTimeout'],
  ServerResponse: ['writeHead', 'writeHeader', 'writeContinue', 'assignSocket', 'detachSocket', '_implicitHeader'],
  ClientRequest: ['abort', 'destroy', 'onSocket', 'setNoDelay', 'setSocketKeepAlive', 'clearTimeout', 'setTimeout'],
};
for (const [name, list] of Object.entries(methods)) {
  console.log(`${name}.prototype own:`, list.map((m) => `${m}=${Object.prototype.hasOwnProperty.call(http[name].prototype, m)}`).join(' '));
}
for (const name of ['headers', 'trailers', 'connection']) {
  console.log(`IncomingMessage.prototype ${name}:`, typeof Object.getOwnPropertyDescriptor(http.IncomingMessage.prototype, name)?.get);
}
for (const name of ['headersSent', 'writableEnded', 'writableFinished', 'socket', 'connection']) {
  console.log(`OutgoingMessage.prototype ${name}:`, typeof Object.getOwnPropertyDescriptor(http.OutgoingMessage.prototype, name)?.get);
}
console.log('ServerResponse.prototype.statusCode', http.ServerResponse.prototype.statusCode);

const socket = new net.Socket();
const req = new http.IncomingMessage(socket);
console.log('new IncomingMessage:', req instanceof stream.Readable, req.socket === socket, req.connection === socket, JSON.stringify({
  method: req.method, url: req.url, headers: req.headers, rawHeaders: req.rawHeaders, statusCode: req.statusCode, complete: req.complete, httpVersion: req.httpVersion, trailers: req.trailers, aborted: req.aborted,
}));

const res = new http.ServerResponse(req);
console.log('new ServerResponse:', res instanceof http.OutgoingMessage, res instanceof stream.Writable, res instanceof stream.Stream, JSON.stringify({
  statusCode: res.statusCode, headersSent: res.headersSent, finished: res.finished, writableEnded: res.writableEnded, sendDate: res.sendDate, header: res._header, destroyed: res.destroyed, writable: res.writable, socket: res.socket,
}));
res.setHeader('X-One', 1);
res.appendHeader('X-One', 'two');
res.setHeaders(new Map([['Content-Type', 'text/plain'], ['set-cookie', ['a=1', 'b=2']]]));
console.log('headers', JSON.stringify(res.getHeaders()), res.getHeaderNames(), res.getRawHeaderNames(), res.hasHeader('x-one'), res.getHeader('X-ONE'));
res.removeHeader('content-type');
console.log('removed', res.hasHeader('content-type'), Object.getPrototypeOf(res.getHeaders()));
for (const bad of [() => res.setHeader('bad name', 'x'), () => res.setHeader('X-Undef', undefined), () => res.getHeader(1)]) {
  try {
    bad();
  } catch (err) {
    console.log('throws', err.code);
  }
}
try {
  new http.OutgoingMessage().write('x');
} catch (err) {
  console.log('OutgoingMessage write', err.code);
}

function MockResponse(req, done) {
  http.ServerResponse.call(this, req);
  this.chunks = [];
  this.once('finish', () => done(this));
  this.assignSocket(new stream.Writable({ write: (chunk, encoding, callback) => setImmediate(callback) }));
}
util.inherits(MockResponse, http.ServerResponse);
MockResponse.prototype.write = function (data, encoding, callback) {
  this.chunks.push(Buffer.from(data, encoding));
  return http.ServerResponse.prototype.write.call(this, data, encoding, callback);
};

const agent = http.Agent();
const server = http.Server();
console.log('without new:', agent instanceof http.Agent, agent.defaultPort, agent.protocol, server instanceof http.Server, server instanceof net.Server);

const mockReq = new http.IncomingMessage(new net.Socket());
mockReq.method = 'GET';
mockReq.httpVersionMajor = 1;
mockReq.httpVersionMinor = 1;
const mock = new MockResponse(mockReq, () => {
  console.log('mock finished', mock.statusCode, mock.writableFinished, Buffer.concat(mock.chunks).toString(), JSON.stringify(mock._header.replace(/\r\nDate: [^\r]*/, '')));
  live();
});
mock.statusCode = 203;
mock.setHeader('X-Mock', 'yes');
mock.write('mocked');
mock.end();

function live() {
  const srv = http.createServer((req, res) => {
    const reqProto = Object.create(http.IncomingMessage.prototype);
    const resProto = Object.create(http.ServerResponse.prototype);
    reqProto.extra = () => 'req-extra';
    resProto.extra = () => 'res-extra';
    console.log('live', P(req) === http.IncomingMessage.prototype, P(res) === http.ServerResponse.prototype, req.socket === res.socket);
    Object.setPrototypeOf(req, reqProto);
    Object.setPrototypeOf(res, resProto);
    console.log('swapped', req.extra(), res.extra(), typeof req.destroy, typeof req.pipe, req instanceof http.IncomingMessage, res instanceof http.ServerResponse);
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      res.on('finish', () => console.log('res finish', res.writableFinished, res.headersSent));
      res.on('close', () => console.log('res close'));
      res.statusCode = 201;
      res.setHeader('Content-Type', 'text/plain');
      res.end(`got ${body}`);
    });
  });
  srv.listen(0, '127.0.0.1', () => {
    const creq = http.request({ host: '127.0.0.1', port: srv.address().port, method: 'POST', agent: false }, (cres) => {
      console.log('client', P(cres) === http.IncomingMessage.prototype, cres.statusCode, cres.headers['content-type'], cres.req === creq);
      let data = '';
      cres.on('data', (chunk) => (data += chunk));
      cres.on('end', () => {
        console.log('client body', data);
        srv.close(() => console.log('closed'));
      });
    });
    console.log('request', creq instanceof http.ClientRequest, creq instanceof http.OutgoingMessage, P(creq) === http.ClientRequest.prototype);
    creq.setNoDelay(true);
    creq.setSocketKeepAlive(false);
    creq.end('hello');
  });
}
