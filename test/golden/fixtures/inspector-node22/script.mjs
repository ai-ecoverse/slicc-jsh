// require('inspector') and 'inspector/promises' load with Node 22.22.0's
// exports (playwright-core requires the inspector at load). Here the
// inspector is not active, as in a Node started without --inspect: the
// answers that holds for, and the argument checks.
import inspectorDefault, { Session as NamedSession, url as namedUrl } from 'node:inspector';
import * as ns from 'inspector';
import * as pns from 'inspector/promises';
import { createRequire, isBuiltin, builtinModules } from 'node:module';
import { EventEmitter } from 'node:events';

const require = createRequire(import.meta.url);
const inspector = require('inspector');
const ip = require('inspector/promises');
const show = (label, f) => {
  try {
    const v = f();
    console.log(label, v === undefined ? 'undefined' : JSON.stringify(v));
  } catch (e) {
    console.log(label, 'throws', e.name, e.code, e.message);
  }
};
const showA = async (label, f) => {
  try {
    const v = await f();
    console.log(label, v === undefined ? 'undefined' : JSON.stringify(v));
  } catch (e) {
    console.log(label, 'rejects', e.name, e.code, e.message);
  }
};
process.on('warning', (w) => console.log('warning', w.name, w.message));

show('keys', () => Object.keys(inspector));
show('promises keys', () => Object.keys(ip));
show('same', () => [require('node:inspector') === inspector, inspectorDefault === inspector, ns.default === inspector, NamedSession === inspector.Session, namedUrl === inspector.url, pns.default === ip, ip.Session !== inspector.Session, ip.open === inspector.open, ip.console === inspector.console, ip.Network === inspector.Network]);
show('esm keys', () => [Object.keys(ns).sort(), Object.keys(pns).sort()]);
show('builtin', () => [isBuiltin('inspector'), isBuiltin('node:inspector/promises'), builtinModules.includes('inspector'), builtinModules.includes('inspector/promises')]);
show('functions', () => Object.entries(inspector).filter(([, v]) => typeof v === 'function').map(([k, v]) => `${k}:${v.name}/${v.length}`));
show('console', () => [Object.keys(inspector.console), Object.values(inspector.console).every((f) => typeof f === 'function'), inspector.console.log('x')]);
show('Network', () => [Object.keys(inspector.Network), Object.entries(inspector.Network).map(([k, f]) => `${k}:${f.name}/${f.length}`), inspector.Network.requestWillBeSent({}), inspector.Network.dataReceived()]);
show('Network params', () => inspector.Network.loadingFailed(1));
show('url', () => inspector.url());
show('close', () => inspector.close());
show('waitForDebugger', () => inspector.waitForDebugger());
show('open port', () => inspector.open(70000));
show('Session', () => {
  const s = new inspector.Session();
  const p = new ip.Session();
  return [s instanceof EventEmitter, p instanceof inspector.Session, Object.getPrototypeOf(ip.Session) === inspector.Session, ip.Session.name, Object.getOwnPropertyNames(inspector.Session.prototype), Object.getOwnPropertyNames(ip.Session.prototype), s.disconnect()];
});
show('post', () => new inspector.Session().post('Runtime.evaluate', { expression: '1' }, () => {}));
show('post method', () => new inspector.Session().post(1));
show('post params', () => new inspector.Session().post('x', 5));
show('post callback', () => new inspector.Session().post('x', {}, 5));
show('connectToMainThread', () => new inspector.Session().connectToMainThread());
await showA('promises post', () => new ip.Session().post('Runtime.evaluate', { expression: '1' }));
await showA('promises post method', () => new ip.Session().post(1));
// Last: the warning it emits comes on a later tick.
show('NetworkResources', () => [Object.keys(inspector.NetworkResources), inspector.NetworkResources.put.name, inspector.NetworkResources.put.length, inspector.NetworkResources.put('a', 'b')]);
