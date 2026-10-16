try { require('./lib/a'); } catch (e) { console.log(e.code, JSON.stringify(e.requireStack.map((p) => require('path').relative(__dirname, p)))); }
