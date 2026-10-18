import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { devPackageTree, withJsh } from './helpers.mjs';

const root = fileURLToPath(new URL('../..', import.meta.url));
const version = (name) => JSON.parse(readFileSync(join(root, 'node_modules', name, 'package.json'), 'utf8')).version;

// The real jest 29 runs a project's tests in the kernel. On its way it calls
// process.constructor without new (jest-util's createProcessObject), copies
// Module's keys onto a subclass (jest-runtime), and clones call sites from
// their prototype (source-map-support).
describe('jest (kernel)', () => {
  let jsh;
  before(async () => {
    jsh = await withJsh();
    for (const [path, data] of devPackageTree('jest')) await jsh.kernel.writeFile(path, data);
    await jsh.kernel.writeFile('/os/proj/package.json', JSON.stringify({ name: 'proj', private: true, jest: { testEnvironment: 'node' } }));
    await jsh.kernel.writeFile(
      '/os/proj/sum.js',
      'module.exports = (a, b) => {\n  if (typeof a !== "number") throw new TypeError("not a number");\n  return a + b;\n};\n'
    );
    await jsh.kernel.writeFile(
      '/os/proj/sum.test.js',
      `const sum = require('./sum');
test('adds', () => expect(sum(1, 2)).toBe(3));
test('throws', () => expect(() => sum('x')).toThrow(TypeError));
test('async', async () => expect(await Promise.resolve(sum(2, 2))).toEqual(4));
`
    );
    await jsh.kernel.writeFile(
      '/os/proj/mock.test.js',
      `test('a mock', () => {
  const fn = jest.fn((x) => x * 2);
  [1, 2].map(fn);
  expect(fn).toHaveBeenCalledTimes(2);
  expect(fn.mock.results.map((r) => r.value)).toEqual([2, 4]);
});
test.each([[1, 1, 2], [2, 3, 5]])('%i + %i', (a, b, c) => expect(a + b).toBe(c));
`
    );
    await jsh.kernel.writeFile(
      '/os/proj/fail.test.js',
      `test('fails', () => {
  expect({ a: 1 }).toEqual({ a: 2 });
});
`
    );
  });
  after(() => jsh?.close());

  it('runs a project in band: passing suites, and a failing one with its diff and source frame', async () => {
    assert.equal(version('jest'), '29.7.0');
    const r = await jsh.run(['node', '/node_modules/jest/bin/jest.js', '--runInBand', '--no-cache', '--ci'], { cwd: '/os/proj' });
    assert.equal(r.status, 1, r.stderr);
    // (A slow suite's line has its time.) No warning of jsh's own: Babel's
    // circular requires are marked __esModule.
    assert.doesNotMatch(r.stderr, /Warning/);
    assert.match(r.stderr, /^PASS \.\/sum\.test\.js( \([\d.]+ m?s\))?$/m);
    assert.match(r.stderr, /^PASS \.\/mock\.test\.js( \([\d.]+ m?s\))?$/m);
    assert.match(r.stderr, /^FAIL \.\/fail\.test\.js( \([\d.]+ m?s\))?$/m);
    // The failure's diff, and its source frame from source-map-support's call sites.
    assert.ok(r.stderr.includes('-   "a": 2,\n    +   "a": 1,'), r.stderr);
    assert.ok(r.stderr.includes('    > 2 |   expect({ a: 1 }).toEqual({ a: 2 });'), r.stderr);
    assert.match(r.stderr, /^ {6}at (Object\.)?toEqual \(fail\.test\.js:2:20\)$/m);
    assert.match(r.stderr, /^Tests: {7}1 failed, 6 passed, 7 total$/m);
    assert.match(r.stderr, /^Test Suites: 1 failed, 2 passed, 3 total$/m);
  });
});
