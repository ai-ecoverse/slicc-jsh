// worker_threads edges against Node 22: a Worker made after process.chdir()
// starts there; one whose workerData can't be cloned (a function), or whose
// transferList has a port already moved to another thread, throws a
// DataCloneError from the constructor and leaves nothing to keep the program
// alive; a post to a running worker that can't be cloned throws, and the
// posts after it still come; and worker.threadName is the name given (null
// once the worker has exited); and a non-string execArgv entry is coerced,
// as the worker sees it; and -e, -p, --check and -i in a worker's execArgv,
// its own or its parent's, don't change what it runs; a worker that
// transfers its parentPort away still prints, and its error and exit still
// come; what a port that hasn't started holds outlasts a close (its own, its
// other end's, a worker's), for receiveMessageOnPort() or a later listener;
// and a port whose worker unref'd it and exited closes here, so the
// program ends.
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

  const { port1: back, port2: there } = new MessageChannel();
  const mover = new Worker(
    "const { parentPort, workerData } = require('worker_threads'); workerData.postMessage(parentPort, [parentPort]); console.log('it still prints'); throw new Error('its error still comes');",
    { eval: true, workerData: there, transferList: [there], stdout: true }
  );
  let printed = '';
  mover.stdout.on('data', (chunk) => (printed += chunk));
  const moverError = once(mover, 'error');
  const moverExit = once(mover, 'exit');
  const came = await once(back, 'message');
  console.log('a worker moved its parentPort here:', typeof came.postMessage);
  console.log('then:', (await moverError).message, '- exit', await moverExit, '- printed:', printed.trim());
  came.close();
  back.close();

  const { receiveMessageOnPort } = require('worker_threads');
  const peerClosed = new MessageChannel();
  peerClosed.port1.postMessage('before its other end closed');
  peerClosed.port1.close();
  const selfClosed = new MessageChannel();
  selfClosed.port1.postMessage('before it closed itself');
  selfClosed.port2.close();
  const later = new MessageChannel();
  later.port1.postMessage('before a listener came');
  later.port1.close();
  await new Promise((resolve) => setImmediate(resolve));
  console.log('kept:', receiveMessageOnPort(peerClosed.port2)?.message, '|', receiveMessageOnPort(selfClosed.port2)?.message);
  const heard = [];
  later.port2.on('message', (m) => heard.push(m));
  await once(later.port2, 'close');
  console.log('a listener after the close heard:', heard.join(', '), 'then close');
  const { port1: lent, port2: kept } = new MessageChannel();
  const poster = new Worker("const { workerData } = require('worker_threads'); workerData.postMessage('from a worker'); workerData.close();", { eval: true, workerData: lent, transferList: [lent] });
  await once(poster, 'exit');
  const fromWorker = await new Promise((resolve) => {
    const poll = () => {
      const got = receiveMessageOnPort(kept);
      if (got) resolve(got.message);
      else setImmediate(poll);
    };
    poll();
  });
  console.log('kept from a worker that closed it:', fromWorker);

  const { port1, port2 } = new MessageChannel();
  const unrefs = new Worker("require('worker_threads').parentPort.once('message', ({ port }) => { port.on('message', () => {}); port.unref(); port.postMessage('hi'); });", { eval: true });
  const closed = once(port1, 'close');
  const exited = once(unrefs, 'exit');
  unrefs.postMessage({ port: port2 }, [port2]);
  port1.on('message', (m) => console.log('a port its worker unrefs got:', m));
  await Promise.all([closed, exited]);
  console.log('and closed when that worker exited');
})();
process.on('exit', () => console.log('the program ends'));
