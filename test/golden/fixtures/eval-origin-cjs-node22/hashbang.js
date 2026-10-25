#!/usr/bin/env node
const run = globalThis["ev" + "al"];
try { run("null.h"); } catch (e) { console.log(e.stack); }
