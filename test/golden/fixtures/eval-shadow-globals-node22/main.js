const { spawnSync } = require('child_process');
const run = (args, input) => {
  const r = spawnSync(process.execPath, args, { cwd: __dirname, encoding: 'utf8', argv0: 'node', input, timeout: 20000 });
  console.log(`== ${JSON.stringify(args)}${input === undefined ? '' : ` < ${JSON.stringify(input)}`}: status ${r.status} ${r.signal ?? ''}`);
  process.stdout.write(r.stdout);
  process.stdout.write(r.stderr.split('\n').filter((line) => !line.startsWith('    at ')).join('\n'));
};
const out = 'globalThis.process.stdout.write';
const cases = [
  'const { setTimeout } = require("timers/promises"); (async () => { await setTimeout(5); console.log("awaited"); setImmediate(() => console.log("immediate")) })()',
  'let setTimeout = 2; require("fs").readFile("data.txt", "utf8", (e, s) => { console.log("read", s.trim(), typeof setTimeout); setInterval(function () { console.log("interval"); clearInterval(this) }, 1) })',
  `const process = { fake: true }; ${out}("fake " + process.fake + "\\n"); require("zlib").gzip("x", (e, b) => { ${out}("gzip " + require("zlib").gunzipSync(b) + "\\n"); globalThis.setTimeout(() => ${out}("timer\\n"), 1) })`,
  'const Buffer = 1; require("stream").Readable.from(["a", "b"]).on("data", (d) => console.log("data", String(d))).on("end", () => console.log("end", typeof Buffer, require("buffer").Buffer.from("hi").toString("hex")))',
  'const queueMicrotask = null; Promise.resolve().then(() => console.log("then")); process.nextTick(() => console.log("tick")); setImmediate(() => { console.log("immediate"); require("fs").promises.readFile("data.txt", "utf8").then((s) => console.log("fsp", s.trim())) })',
  'const Promise = 5; (async () => { await null; console.log("async"); const s = await require("fs/promises").readFile("data.txt", "utf8"); console.log("fsp", s.trim(), typeof Promise); await require("timers/promises").setTimeout(1); console.log("timers/promises") })()',
  `const console = { log() {} }; ${out}("before\\n"); new (require("console").Console)(globalThis.process.stdout).log("own console", require("util").inspect({ a: 1 })); setTimeout(() => ${out}("timer\\n"), 1)`,
  'const Object = 1, Array = 2, Error = 3, JSON = 4, Symbol = 5, Map = 6; require("stream").Readable.from(["x"]).pipe(require("zlib").createGzip()).pipe(require("zlib").createGunzip()).on("data", (d) => console.log("piped", String(d))).on("end", () => setTimeout(() => console.log("timer", typeof Object), 1))',
  'const setImmediate = 0, clearTimeout = 0, structuredClone = 0, TextDecoder = 0, TextEncoder = 0, URL = 0; require("http").createServer((q, s) => s.end("ok")).listen(0, function () { require("http").get(`http://127.0.0.1:${this.address().port}/`, (res) => { res.setEncoding("utf8"); res.on("data", (d) => { console.log("http", d); this.close() }) }) })',
  'const globalThis = { fake: 1 }; require("crypto").randomBytes(4, (e, b) => { console.log("random", b.length); setTimeout(() => console.log("timer", globalThis.fake), 1) })',
];
for (const code of cases) {
  run(['-e', code]);
  run([], code);
}
