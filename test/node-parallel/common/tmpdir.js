'use strict';
const fs = require('fs');
const path = require('path');

const path_ = path.join(process.cwd(), 'tmp');

function refresh() {
  try {
    fs.rmSync(path_, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
  fs.mkdirSync(path_, { recursive: true });
}

function resolve(...args) {
  return path.join(path_, ...args);
}

module.exports = {
  path: path_,
  refresh,
  resolve,
};
