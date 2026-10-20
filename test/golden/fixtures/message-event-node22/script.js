const util = require('util');
const { MessageChannel } = require('worker_threads');
const show = (label, fn) => {
  try {
    const v = fn();
    console.log(label, '=>', typeof v === 'string' ? JSON.stringify(v) : util.inspect(v, { depth: 1 }));
  } catch (e) {
    console.log(label, 'THROW', e.name, e.code, JSON.stringify(e.message));
  }
};
const E = MessageEvent;
const g = Object.getOwnPropertyDescriptor(globalThis, 'MessageEvent');
console.log('global', g.writable, g.enumerable, g.configurable, g.value === E);
console.log('class', E.name, E.length, Object.getPrototypeOf(E) === Event, Object.getOwnPropertyNames(E).sort().join());
for (const k of Object.getOwnPropertyNames(E.prototype)) {
  const d = Object.getOwnPropertyDescriptor(E.prototype, k);
  const fn = d.get ?? d.value;
  console.log(' ', k, Object.keys(d).join(','), d.enumerable, d.configurable, typeof fn === 'function' ? `${fn.name}/${fn.length}` : '');
}
console.log('tag', Object.prototype.toString.call(new E('x')), E.prototype[Symbol.toStringTag]);
show('no args', () => new E());
show('Symbol type', () => new E(Symbol('s')));
show('init null', () => { const e = new E('m', null); return [e.data, e.origin, e.lastEventId, e.source, e.ports]; });
show('init undefined', () => { const e = new E('m', undefined); return [e.data, e.origin, e.ports]; });
show('init number', () => new E('m', 5));
show('init string', () => new E('m', 'x'));
show('ports 1', () => new E('m', { ports: 1 }));
show('ports [1]', () => new E('m', { ports: [1] }));
show('ports ["a"]', () => new E('m', { ports: ['a'] }));
show('ports [{}]', () => new E('m', { ports: [{ a: 1 }] }));
show('ports null', () => new E('m', { ports: null }));
show('ports Symbol', () => new E('m', { ports: Symbol('p') }));
show('ports not iterable', () => new E('m', { ports: {} }));
show('ports a Set', () => new E('m', { ports: new Set() }).ports);
show('source 1', () => new E('m', { source: 1 }));
show('source {}', () => new E('m', { source: {} }));
show('source null', () => new E('m', { source: null }).source);
const { port1, port2 } = new MessageChannel();
show('source port', () => new E('m', { source: port1 }).source === port1);
show('ports port', () => {
  const list = [port1];
  const e = new E('m', { ports: list });
  return [e.ports.length, Object.isFrozen(e.ports), e.ports === e.ports, e.ports[0] === port1, e.ports === list];
});
show('defaults', () => {
  const e = new E('m');
  return [e.data, e.origin, e.lastEventId, e.source, e.ports, e.type, e.bubbles, e.cancelable, e.composed, e.isTrusted];
});
show('coerce', () => {
  const e = new E(1, { origin: 2, lastEventId: 3, data: undefined, bubbles: 1, cancelable: 'y', composed: 0 });
  return [e.type, e.origin, e.lastEventId, e.data, e.bubbles, e.cancelable, e.composed];
});
show('null fields', () => { const e = new E('m', { data: null, origin: null, lastEventId: null }); return [e.data, e.origin, e.lastEventId]; });
show('init read order', () => {
  const seen = [];
  new E('m', new Proxy({}, { get: (t, k) => { if (typeof k === 'string') seen.push(k); } }));
  return seen.join(' ');
});
show('lone surrogate origin', () => new E('m', { origin: 'a\ud800' }).origin.length);
show('origin symbol', () => new E('m', { origin: Symbol('o') }));
show('lastEventId symbol', () => new E('m', { lastEventId: Symbol('l') }));
for (const k of ['data', 'origin', 'lastEventId', 'source', 'ports']) {
  show(`brand ${k}`, () => Object.getOwnPropertyDescriptor(E.prototype, k).get.call({}));
}
show('brand on an Event', () => Object.getOwnPropertyDescriptor(E.prototype, 'data').get.call(new Event('x')));
show('initMessageEvent', () => {
  const e = new E('m');
  const r = e.initMessageEvent('n', true, true, 7, 'o', 'l', null, []);
  return [r === e, r instanceof E, r.type, r.bubbles, r.cancelable, r.data, r.origin, r.lastEventId, e.type];
});
show('initMessageEvent defaults', () => { const r = new E('m').initMessageEvent('n'); return [r.data, r.origin, r.ports]; });
show('initMessageEvent no args', () => new E('m').initMessageEvent());
show('initMessageEvent brand', () => E.prototype.initMessageEvent.call({}, 'x'));
show('inspect', () => util.inspect(new E('m', { data: { a: 1 } })).replace(/timeStamp: [\d.]+/, 'timeStamp: N'));
show('inspect nested', () => util.inspect({ a: { b: new E('m') } }, { depth: 0 }));
show('keys', () => Object.keys(new E('m')));
show('json', () => JSON.stringify(new E('m', { data: 1 })));
show('call', () => E('m'));
show('subclass', () => {
  class S extends E {}
  const s = new S('m', { data: 2 });
  return [s.data, s instanceof E, s.constructor.name, Object.prototype.toString.call(s)];
});
show('dispatch', () => {
  const t = new EventTarget();
  let got;
  t.addEventListener('m', (ev) => { got = [ev.data, ev.target === t, ev instanceof E]; });
  t.dispatchEvent(new E('m', { data: 'x' }));
  return got;
});
port2.onmessage = (ev) => {
  console.log('port message', ev instanceof MessageEvent, ev.constructor === MessageEvent, ev.data, ev.ports.length, Object.isFrozen(ev.ports));
  port1.close();
  const a = new BroadcastChannel('me');
  const b = new BroadcastChannel('me');
  b.onmessage = (m) => {
    console.log('channel message', m instanceof MessageEvent, m.data, m.origin, m.source, m.ports.length);
    a.close();
    b.close();
  };
  a.postMessage('hi');
};
port1.postMessage('hello');
