// require('dns'), require('dns/promises') and their ESM forms: Node 22.22.0's
// export surface, argument checks and the answers that don't depend on the
// host's resolver (IP literals, an empty hostname, the result order).
import dnsDefault, { lookup as namedLookup, promises as namedPromises } from 'node:dns';
import dnsPromisesDefault, { lookup as promisesLookup } from 'node:dns/promises';
import * as ns from 'dns';
import * as pns from 'dns/promises';
import { createRequire, isBuiltin, builtinModules } from 'node:module';
import { promisify } from 'node:util';

const require = createRequire(import.meta.url);
const dns = require('dns');
const dnsp = require('dns/promises');
const out = (label, v) => console.log(label, v === undefined ? 'undefined' : JSON.stringify(v));
const show = (label, f) => {
  try {
    out(label, f());
  } catch (e) {
    console.log(label, 'throws', e.name, e.code, e.message, JSON.stringify(e));
  }
};
const showA = async (label, f) => {
  try {
    out(label, await f());
  } catch (e) {
    console.log(label, 'rejects', e.name, e.code, e.message, JSON.stringify(e));
  }
};
const cb = (label) =>
  new Promise((resolve) => {
    try {
      const r = label[1]((err, ...rest) => {
        out(label[0], err ? ['error', err.code, err.message, Object.keys(err)] : rest);
        resolve();
      });
      void r;
    } catch (e) {
      console.log(label[0], 'throws', e.name, e.code, e.message);
      resolve();
    }
  });
process.on('warning', (w) => console.log('warning', w.name, w.code, w.message));

const surface = (m) => Object.keys(m).filter((k) => !['ADDRCONFIG', 'ALL', 'V4MAPPED'].includes(k));
show('keys', () => Object.keys(dns));
show('promises keys', () => Object.keys(dnsp));
show('same', () => [require('node:dns') === dns, require('node:dns/promises') === dnsp, dns.promises === dnsp, dnsDefault === dns, ns.default === dns, dnsPromisesDefault === dnsp, pns.default === dnsp, namedLookup === dns.lookup, namedPromises === dnsp, promisesLookup === dnsp.lookup]);
show('esm keys', () => Object.keys(ns).sort());
show('esm promises keys', () => Object.keys(pns).sort());
show('builtin', () => [isBuiltin('dns'), isBuiltin('node:dns/promises'), builtinModules.includes('dns'), builtinModules.includes('dns/promises')]);
show('promises descriptor', () => {
  const d = Object.getOwnPropertyDescriptor(dns, 'promises');
  return [typeof d.get, d.set, d.enumerable, d.configurable];
});
show('functions', () => Object.entries(dns).filter(([, v]) => typeof v === 'function').map(([k, v]) => `${k}:${v.name}/${v.length}`));
show('promises functions', () => Object.entries(dnsp).filter(([, v]) => typeof v === 'function').map(([k, v]) => `${k}:${v.name}/${v.length}`));
show('codes', () => surface(dns).filter((k) => typeof dns[k] === 'string').map((k) => `${k}=${dns[k]}`));
show('hint types', () => ['ADDRCONFIG', 'ALL', 'V4MAPPED'].map((k) => typeof dns[k]));
show('Resolver', () => [Object.getOwnPropertyNames(dns.Resolver.prototype), Object.getOwnPropertyNames(Object.getPrototypeOf(dns.Resolver.prototype)), Object.getOwnPropertyNames(dnsp.Resolver.prototype), dns.Resolver === dnsp.Resolver, Object.getPrototypeOf(dns.Resolver) === Object.getPrototypeOf(dnsp.Resolver)]);
show('query names', () => Object.getOwnPropertyNames(dns.Resolver.prototype).filter((k) => k !== 'constructor').map((k) => `${k}:${dns.Resolver.prototype[k].name}/${dns.Resolver.prototype[k].length}:${dnsp.Resolver.prototype[k].name}/${dnsp.Resolver.prototype[k].length}`));
show('promisify', () => [dns.lookup[Symbol.for('nodejs.util.promisify.customArgs')], dns.lookupService[Symbol.for('nodejs.util.promisify.customArgs')]]);
show('order', () => {
  const before = dns.getDefaultResultOrder();
  dns.setDefaultResultOrder('ipv4first');
  const r = [before, dns.getDefaultResultOrder(), dnsp.getDefaultResultOrder()];
  dnsp.setDefaultResultOrder('verbatim');
  return [...r, dns.getDefaultResultOrder()];
});
show('order bad', () => dns.setDefaultResultOrder('random'));

await cb(['lookup v4', (f) => dns.lookup('10.1.2.3', f)]);
await cb(['lookup v6', (f) => dns.lookup('::1', f)]);
await cb(['lookup v6 zone', (f) => dns.lookup('fe80::1%eth0', f)]);
await cb(['lookup all', (f) => dns.lookup('10.1.2.3', { all: true }, f)]);
await cb(['lookup family 6 v4', (f) => dns.lookup('10.1.2.3', 6, f)]);
await cb(['lookup IPv4 string', (f) => dns.lookup('10.1.2.3', { family: 'IPv4' }, f)]);
await cb(['lookup empty', (f) => dns.lookup('', f)]);
await cb(['lookup empty all', (f) => dns.lookup('', { all: true }, f)]);
await cb(['lookup null 6', (f) => dns.lookup(null, 6, f)]);
await cb(['lookup bad family', (f) => dns.lookup('a', 5, f)]);
await cb(['lookup bad options', (f) => dns.lookup('a', 'x', f)]);
await cb(['lookup bad hints', (f) => dns.lookup('a', { hints: 1 }, f)]);
await cb(['lookup hints type', (f) => dns.lookup('a', { hints: 'x' }, f)]);
await cb(['lookup all type', (f) => dns.lookup('a', { all: 1 }, f)]);
await cb(['lookup verbatim type', (f) => dns.lookup('a', { verbatim: 1 }, f)]);
await cb(['lookup order', (f) => dns.lookup('a', { order: 'x' }, f)]);
await cb(['lookup hostname type', (f) => dns.lookup(5, f)]);
show('lookup no callback', () => dns.lookup('a'));
show('lookup no callback options', () => dns.lookup('a', {}));
show('lookup bad options 2 args', () => dns.lookup('a', 'x'));
show('lookup returns', () => typeof dns.lookup('10.0.0.1', () => {}));
await showA('promisified lookup', () => promisify(dns.lookup)('10.1.2.3'));
await showA('promisified lookupService args', async () => Object.keys(await promisify(dns.lookupService)('127.0.0.1', 22)));

await showA('p lookup v4', () => dnsp.lookup('10.1.2.3'));
await showA('p lookup all', () => dnsp.lookup('::1', { all: true }));
await showA('p lookup empty', () => dnsp.lookup(''));
await showA('p lookup empty all', () => dnsp.lookup('', { all: true }));
await showA('p lookup bad family', () => dnsp.lookup('a', { family: 'IPv4' }));
await showA('p lookup bad options', () => dnsp.lookup('a', 'x'));
await showA('p lookup hostname type', () => dnsp.lookup(5));

show('lookupService args', () => dns.lookupService('127.0.0.1', 22));
show('lookupService address', () => dns.lookupService('x', 22, () => {}));
show('lookupService port', () => dns.lookupService('127.0.0.1', 70000, () => {}));
show('lookupService port string', () => dns.lookupService('127.0.0.1', ' ', () => {}));
show('lookupService callback', () => dns.lookupService('127.0.0.1', 22, 5));
await showA('p lookupService args', () => dnsp.lookupService('127.0.0.1'));
await showA('p lookupService address', () => dnsp.lookupService('x', 22));

show('servers', () => {
  const r = new dns.Resolver();
  r.setServers(['8.8.8.8', '1.1.1.1:5353', '[2001:4860:4860::8888]', '[::1]:5300', '2001:db8::1']);
  return r.getServers();
});
show('servers bad', () => new dns.Resolver().setServers(['8.8.8.8', 'not an ip']));
show('servers type', () => new dns.Resolver().setServers('8.8.8.8'));
show('servers element', () => new dns.Resolver().setServers([1]));
show('setServers module', () => {
  dns.setServers(['9.9.9.9']);
  return [dns.getServers(), dnsp.getServers()];
});
show('resolver options', () => new dns.Resolver({ timeout: -2 }));
show('resolver tries', () => new dns.Resolver({ tries: 0 }));
show('resolver maxTimeout', () => new dns.Resolver({ maxTimeout: -1 }));
show('setLocalAddress type', () => new dns.Resolver().setLocalAddress(1));
show('resolve name type', () => dns.resolve4(5, () => {}));
show('resolve callback', () => dns.resolve4('a'));
show('resolve rrtype type', () => dns.resolve('a', 5, () => {}));
show('resolve rrtype value', () => dns.resolve('a', 'BOGUS', () => {}));
show('reverse bad', () => dns.reverse('x', () => {}));
await showA('p reverse bad', () => dnsp.reverse('x'));
await showA('p resolve rrtype type', () => dnsp.resolve('a', 5));
await showA('p resolve rrtype value', () => dnsp.resolve('a', 'BOGUS'));
await showA('p resolve name type', () => dnsp.resolve4(5));
show('resolve returns', () => typeof dns.resolve4('localhost', () => {}));
