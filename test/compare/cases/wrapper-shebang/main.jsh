#!/usr/bin/env jsh
const line = new Error('here').stack.split('\n').find((l) => l.includes('main.'));
console.log('line', /:(\d+):\d+\)?$/.exec(line)?.[1]);
