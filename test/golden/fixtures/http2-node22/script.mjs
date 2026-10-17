// require('http2') and import 'node:http2': Node 22.22.0's export surface, and its pure parts.
import http2Default, { constants as namedConstants, getPackedSettings, Http2ServerResponse, sensitiveHeaders } from 'node:http2';
import * as ns from 'http2';
import { createRequire, isBuiltin, builtinModules } from 'node:module';
import { promisify } from 'node:util';

const require = createRequire(import.meta.url);
const http2 = require('http2');
const net = require('net');
const tls = require('tls');
const stream = require('stream');
const show = (label, f) => {
  try {
    const v = f();
    console.log(label, v === undefined ? 'undefined' : JSON.stringify(v));
  } catch (e) {
    console.log(label, 'throws', e.name, e.code, e.message, JSON.stringify(e));
  }
};
process.on('warning', (w) => console.log('warning', w.name, w.message));

show('keys', () => Object.keys(http2));
show('same', () => [require('node:http2') === http2, http2Default === http2, ns.default === http2, namedConstants === http2.constants, getPackedSettings === http2.getPackedSettings, Http2ServerResponse === http2.Http2ServerResponse, sensitiveHeaders === http2.sensitiveHeaders]);
show('esm keys', () => Object.keys(ns).sort());
show('builtin', () => [isBuiltin('http2'), isBuiltin('node:http2'), builtinModules.includes('http2')]);
show('functions', () => Object.entries(http2).filter(([, v]) => typeof v === 'function').map(([k, v]) => `${k}:${v.name}/${v.length}`));
show('sensitiveHeaders', () => [typeof sensitiveHeaders, String(sensitiveHeaders), Symbol.keyFor(sensitiveHeaders)]);
show('constants', () => http2.constants);
show('constants shape', () => {
  const c = http2.constants;
  const d = Object.getOwnPropertyDescriptor(c, 'HTTP2_HEADER_STATUS');
  return [Object.isFrozen(c), Object.isExtensible(c), Object.getPrototypeOf(c) === Object.prototype, d.writable, d.enumerable, d.configurable, Object.keys(c).length];
});
show('getDefaultSettings', () => {
  const s = http2.getDefaultSettings();
  return [Object.getPrototypeOf(s), Object.keys(s), s, http2.getDefaultSettings() !== s];
});
const packed = (s) => {
  const p = http2.getPackedSettings(s);
  return p === undefined ? 'undefined' : [Buffer.isBuffer(p), p.toString('hex')];
};
show('pack all', () => packed({ headerTableSize: 1, enablePush: false, initialWindowSize: 3, maxFrameSize: 16384, maxConcurrentStreams: 5, maxHeaderListSize: 6, enableConnectProtocol: true }));
show('pack none', () => packed());
show('pack empty', () => packed({}));
show('pack defaults', () => packed(http2.getDefaultSettings()));
show('pack big', () => packed({ maxConcurrentStreams: 4294967295, maxFrameSize: 16777215 }));
show('pack maxHeaderSize', () => packed({ maxHeaderSize: 7 }));
show('pack both header sizes', () => packed({ maxHeaderSize: 7, maxHeaderListSize: 7 }));
show('pack custom', () => packed({ customSettings: { 9: 7 } }));
show('pack custom empty', () => packed({ customSettings: {} }));
show('pack custom non-number', () => packed({ customSettings: { 9: 'x' } }));
show('pack enablePush', () => packed({ enablePush: 1 }));
show('pack enableConnectProtocol', () => packed({ enableConnectProtocol: 'yes' }));
show('pack maxFrameSize low', () => packed({ maxFrameSize: 1 }));
show('pack maxFrameSize high', () => packed({ maxFrameSize: 2 ** 24 }));
show('pack headerTableSize', () => packed({ headerTableSize: -1 }));
show('pack initialWindowSize', () => packed({ initialWindowSize: '1' }));
show('pack customSettings type', () => packed({ customSettings: 5 }));
show('pack custom id', () => packed({ customSettings: { 70000: 1 } }));
show('pack too many', () => packed({ customSettings: Object.fromEntries(Array.from({ length: 11 }, (_, i) => [i + 10, 1])) }));
show('pack null', () => packed(null));
show('pack array', () => packed([]));
const unpack = (hex, options) => http2.getUnpackedSettings(Buffer.from(hex, 'hex'), options);
show('unpack all', () => unpack(http2.getPackedSettings({ headerTableSize: 1, enablePush: false, initialWindowSize: 3, maxFrameSize: 16384, maxConcurrentStreams: 5, maxHeaderListSize: 6, enableConnectProtocol: true }).toString('hex')));
show('unpack custom', () => unpack('000a00000007000100000002000a00000009'));
show('unpack u8', () => http2.getUnpackedSettings(new Uint8Array([0, 2, 0, 0, 0, 1])));
show('unpack view', () => http2.getUnpackedSettings(new Uint8Array([9, 0, 4, 0, 0, 1, 0, 9]).subarray(1, 7)));
show('unpack empty', () => unpack(''));
show('unpack length', () => unpack('0001000000'));
show('unpack string', () => http2.getUnpackedSettings('x'));
show('unpack validate', () => unpack('000500000001', { validate: true }));
show('unpack no validate', () => unpack('000500000001'));

show('classes', () => [
  Object.getPrototypeOf(http2.Http2ServerRequest) === stream.Readable,
  Object.getPrototypeOf(http2.Http2ServerResponse) === stream.Stream,
  http2.Http2ServerRequest.prototype instanceof stream.Readable,
  http2.Http2ServerResponse.prototype instanceof stream.Stream,
  ['aborted', 'complete', 'stream', 'headers', 'rawHeaders', 'trailers', 'rawTrailers', 'httpVersionMajor', 'httpVersionMinor', 'httpVersion', 'method', 'authority', 'scheme', 'url'].every((k) => Object.getOwnPropertyDescriptor(http2.Http2ServerRequest.prototype, k)?.get),
  ['stream', 'statusCode', 'writableEnded', 'finished'].every((k) => Object.getOwnPropertyDescriptor(http2.Http2ServerResponse.prototype, k)?.get),
  ['getHeader', 'getHeaderNames', 'getHeaders', 'hasHeader'].every((k) => typeof http2.Http2ServerResponse.prototype[k] === 'function'),
]);
show('server', () => {
  const s = http2.createServer(() => {});
  const t = http2.createServer({ settings: { enablePush: false } });
  return [s instanceof net.Server, t instanceof net.Server, s.constructor.name, s.listenerCount('request'), s.timeout, s.setTimeout(5) === s, s.timeout, s.listening];
});
show('secure server', () => {
  const s = http2.createSecureServer({}, () => {});
  return [s instanceof tls.Server, s instanceof net.Server, s.constructor.name, s.listenerCount('request'), [...s.ALPNProtocols]];
});
show('server options', () => http2.createServer(5));
show('server settings', () => http2.createServer({ settings: { maxFrameSize: 3 } }) instanceof net.Server);
show('server invalid frames', () => http2.createServer({ maxSessionInvalidFrames: -1 }));
show('server setTimeout', () => http2.createServer().setTimeout(1, 5));
show('server settings type', () => http2.createServer({ settings: 'x' }));
show('updateSettings', () => http2.createServer().updateSettings({ enablePush: 'no' }));
show('connect options', () => http2.connect('http://localhost:1', 5));
show('connect authority', () => http2.connect(5));
show('connect protocol', () => http2.connect('ftp://localhost:1'));
show('connect remoteCustomSettings', () => http2.connect('http://localhost:1', { remoteCustomSettings: 5 }));
show('connect too many', () => http2.connect('http://localhost:1', { remoteCustomSettings: Array(11).fill(1) }));
show('promisify', () => [typeof http2.connect[promisify.custom], http2.connect[promisify.custom]?.name, promisify(http2.connect) === http2.connect[promisify.custom]]);
