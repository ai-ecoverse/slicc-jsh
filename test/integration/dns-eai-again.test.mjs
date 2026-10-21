import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createDns } from '../../src/runtime/builtins/dns.mjs';

const fields = (e) => [e.message, e.code, e.errno, e.syscall, e.hostname, Object.keys(e).join()].join(' | ');
const nodeEaiAgain = (name) => `getaddrinfo EAI_AGAIN ${name} | EAI_AGAIN | -3001 | getaddrinfo | ${name} | errno,code,syscall,hostname`;

function dnsRejecting(error) {
  const asked = [];
  const ctx = {
    net: {
      resolve: async (name, options) => {
        asked.push([name, options.family]);
        throw error;
      },
    },
  };
  const process = { nextTick: (fn, ...args) => queueMicrotask(() => fn(...args)), emitWarning() {} };
  return { dns: createDns({ ctx, process }).dns, asked };
}

const callback = (f) => new Promise((resolve) => f((err, ...rest) => resolve(err ?? rest)));

describe('dns: the resolver answering EAI_AGAIN', () => {
  for (const [label, error] of [
    ['its code', Object.assign(new Error('resolve db.example.test'), { code: 'EAI_AGAIN' })],
    ['its cause', new Error('resolve db.example.test', { cause: { code: 'EAI_AGAIN' } })],
  ]) {
    it(`lookup is Node's getaddrinfo EAI_AGAIN (${label})`, async () => {
      const { dns, asked } = dnsRejecting(error);
      assert.equal(fields(await callback((f) => dns.lookup('db.example.test', f))), nodeEaiAgain('db.example.test'));
      assert.equal(fields(await callback((f) => dns.lookup('db.example.test', { all: true, family: 6 }, f))), nodeEaiAgain('db.example.test'));
      assert.equal(fields(await dns.promises.lookup('db.example.test').catch((e) => e)), nodeEaiAgain('db.example.test'));
      assert.deepEqual(asked, [['db.example.test', 0], ['db.example.test', 6], ['db.example.test', 0]]);
    });

    it(`resolve4 and resolve6 are c-ares' ETIMEOUT (${label})`, async () => {
      const { dns } = dnsRejecting(error);
      const timeout = (syscall) => `${syscall} ETIMEOUT db.example.test | ETIMEOUT |  | ${syscall} | db.example.test | errno,code,syscall,hostname`;
      assert.equal(fields(await callback((f) => dns.resolve4('db.example.test', f))), timeout('queryA'));
      assert.equal(fields(await dns.promises.resolve6('db.example.test').catch((e) => e)), timeout('queryAaaa'));
    });
  }

  it('any other rejection is getaddrinfo ENOTFOUND, and queryA ENOTFOUND', async () => {
    const { dns } = dnsRejecting(Object.assign(new Error('resolve x.test'), { code: 'EINTR' }));
    assert.equal(
      fields(await callback((f) => dns.lookup('x.test', f))),
      'getaddrinfo ENOTFOUND x.test | ENOTFOUND | -3008 | getaddrinfo | x.test | errno,code,syscall,hostname'
    );
    assert.equal(fields(await callback((f) => dns.resolve4('x.test', f))), 'queryA ENOTFOUND x.test | ENOTFOUND |  | queryA | x.test | errno,code,syscall,hostname');
  });
});
