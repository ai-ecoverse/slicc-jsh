const cases = [
  ['semver', "import { satisfies, valid } from 'semver'; export default [satisfies('1.2.3', '^1'), valid('x')]"],
  ['lodash', "import { chunk } from 'lodash'; export default chunk([1,2,3], 2)"],
  ['lodash default', "import _ from 'lodash'; export default _.chunk([1,2,3], 2)"],
  ['minimist', "import minimist from 'minimist'; export default minimist(['--a', '1'])"],
  ['debug', "import debug from 'debug'; export default typeof debug('x')"],
  ['chalk4', "import { red } from 'chalk'; export default typeof red"],
  ['chalk4 default', "import chalk from 'chalk'; export default typeof chalk.red"],
  ['commander', "import { Command } from 'commander'; export default typeof Command"],
  ['express', "import express, { Router } from 'express'; export default [typeof express, typeof Router]"],
  ['react', "import { createElement, useState } from 'react'; export default [typeof createElement, typeof useState]"],
  ['uuid', "import { v4, validate } from 'uuid'; export default validate(v4())"],
  ['js-yaml', "import { load, dump } from 'js-yaml'; export default load('a: 1')"],
  ['glob', "import { globSync } from 'glob'; export default Array.isArray(globSync('*.mjs'))"],
  ['rimraf', "import { rimraf } from 'rimraf'; export default typeof rimraf"],
  ['fs-extra', "import { ensureDirSync, readJsonSync } from 'fs-extra'; export default [typeof ensureDirSync, typeof readJsonSync]"],
  ['fs-extra default', "import fse from 'fs-extra'; export default typeof fse.ensureDirSync"],
  ['axios', "import axios, { AxiosError } from 'axios'; export default [typeof axios.get, typeof AxiosError]"],
  ['dotenv', "import { config, parse } from 'dotenv'; export default parse('A=1')"],
  ['cookie', "import { parse, serialize } from 'cookie'; export default parse('a=b')"],
  ['qs', "import { parse, stringify } from 'qs'; export default parse('a[b]=1')"],
  ['mime-types', "import { lookup } from 'mime-types'; export default lookup('x.json')"],
  ['ws', "import { WebSocketServer, WebSocket } from 'ws'; export default [typeof WebSocketServer, typeof WebSocket]"],
  ['yaml', "import { parse } from 'yaml'; export default parse('b: 2')"],
];
const fs = await import('node:fs');
for (const [name, src] of cases) {
  const f = `./t-${name.replace(/\W/g, '_')}.mjs`;
  try { const m = await import(f); console.log('OK  ', name, JSON.stringify(m.default)); } catch (e) { console.log('FAIL', name, e.code ?? e.name, String(e.message).split('\n')[0].slice(0, 140)); }
}
