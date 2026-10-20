// worker_threads edges against Node 22: a Worker made after process.chdir()
// starts there; one whose workerData can't be cloned (a function), or whose
// transferList has a port already moved to another thread, throws a
// DataCloneError from the constructor and leaves nothing to keep the program
// alive; a post to a running worker that can't be cloned throws, and the
// posts after it still come; and worker.threadName is the name given (null
// once the worker has exited); and a non-string execArgv entry is coerced,
// as the worker sees it; and -e, -p, --check and -i in a worker's execArgv,
// its own or its parent's, don't change what it runs.
const { Worker, MessageChannel } = require('worker_threads');
const path = require('path');
const once = (w, ev) => new Promise((r) => w.once(ev, r));
(async () => {
  process.chdir(path.join(__dirname, 'sub'));
  const w1 = new Worker("require('worker_threads').parentPort.postMessage(require('path').basename(process.cwd()))", { eval: true });
  console.log('cwd in a worker made after chdir:', await once(w1, 'message'));
  await once(w1, 'exit');

  try {
    new Worker('0', { eval: true, workerData: () => {} });
    console.log('constructed');
  } catch (e) {
    console.log('workerData that cannot be cloned:', e.name, e.message);
  }

  const echo = new Worker("const { parentPort } = require('worker_threads'); parentPort.on('message', (m) => parentPort.postMessage(typeof m === 'string' ? m : 'a port came'));", { eval: true });
  await once(echo, 'online');
  // A port moved to the echo worker is gone from here.
  const { port1: moved } = new MessageChannel();
  echo.postMessage({ moved }, [moved]);
  await once(echo, 'message');
  try {
    new Worker('0', { eval: true, workerData: { p: moved }, transferList: [moved] });
    console.log('constructed');
  } catch (e) {
    console.log('a transferList with a port moved to another thread:', e.name);
  }
  const got = [];
  const both = new Promise((resolve) =>
    echo.on('message', (m) => {
      got.push(m);
      if (got.length === 2) resolve();
    })
  );
  try {
    echo.postMessage(() => {});
  } catch (e) {
    console.log('a post that cannot be cloned:', e.name);
  }
  echo.postMessage('one');
  echo.postMessage('two');
  await both;
  console.log('the posts after it:', got.join(' '));
  await echo.terminate();

  const coerced = new Worker("require('worker_threads').parentPort.postMessage(JSON.stringify(process.execArgv))", {
    eval: true,
    execArgv: [{ toString: () => '--no-warnings' }],
  });
  console.log('a non-string execArgv entry, coerced:', await once(coerced, 'message'));
  await once(coerced, 'exit');

  // -e, -p, --check and -i in a worker's execArgv are inert: it runs its
  // own file, and keeps them in process.execArgv.
  for (const execArgv of [['-e', 'console.log("the eval ran")'], ['-p', '1 + 1'], ['--check'], ['-i']]) {
    const w = new Worker(path.join(__dirname, 'w.js'), { execArgv });
    console.log(JSON.stringify(execArgv), '->', await once(w, 'message'));
    await once(w, 'exit');
  }
  // A parent run with -e passes its execArgv on: the worker still runs w.js.
  const { execFileSync } = require('child_process');
  const fromEval = execFileSync(process.execPath, [
    '-e',
    "const w = new (require('worker_threads').Worker)(process.argv[1]); w.once('message', (m) => console.log(m.replace(/ its execArgv .*/, ' (its parent was -e)')));",
    path.join(__dirname, 'w.js'),
  ]);
  console.log('a worker of a -e program:', String(fromEval).trim());

  const named = new Worker("require('worker_threads').parentPort.postMessage(require('worker_threads').threadName)", { eval: true, name: 'example' });
  console.log('threadName:', JSON.stringify(named.threadName), 'inside:', JSON.stringify(await once(named, 'message')));
  await once(named, 'exit');
  console.log('threadName once it has exited:', JSON.stringify(named.threadName));
})();
process.on('exit', () => console.log('the program ends'));
