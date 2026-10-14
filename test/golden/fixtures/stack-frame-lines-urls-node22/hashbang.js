#!/usr/bin/env node
// line 2
function f() {
  throw new Error('after a hashbang');
}
f();
