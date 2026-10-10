#!/usr/bin/env jsh
// line 2
const line = /main\.jsh:(\d+):/.exec(new Error('here').stack)?.[1];
console.log('error on line', line);
