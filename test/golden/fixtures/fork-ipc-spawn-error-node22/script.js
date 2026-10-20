// A fork or an 'ipc' spawn whose program can't start, or whose cwd is
// missing, still has its channel,
// as in Node: send() is there and returns true, its callback comes after
// 'error' (with EPIPE, or none when Node's write beat the failed child's
// close), and 'close' and the channel's 'disconnect' come (in either
// order in Node, so they are shown after the rest). Each case waits for
// both before the next starts.
const { fork, spawn } = require('child_process');
const here = (s) => String(s).split(process.execPath).join('<execPath>');

const watch = (label, cp) =>
  new Promise((resolve) => {
    const seen = [`connected ${cp.connected} send ${typeof cp.send} channel ${typeof cp.channel} pid ${cp.pid}`];
    const end = {};
    const done = () => {
      if (end.close && end.disconnect) {
        console.log(label, [...seen, end.close, end.disconnect].join(' | '));
        resolve();
      }
    };
    seen.push(`send returns ${cp.send({ a: 1 }, () => seen.push('send callback'))}`);
    cp.on('error', (e) => seen.push(here(`error ${e.code} ${e.syscall} ${e.path}`)));
    cp.on('exit', (code, signal) => seen.push(`exit ${code} ${signal}`));
    cp.on('disconnect', () => {
      end.disconnect = `disconnect connected ${cp.connected}`;
      done();
    });
    cp.on('close', (code, signal) => {
      end.close = `close ${code} ${signal}`;
      done();
    });
  });

(async () => {
  // fork's execPath is spawn's file: a string, or ERR_INVALID_ARG_TYPE.
  for (const execPath of [42, {}, true]) {
    try {
      fork(__filename, [], { execPath });
      console.log('execPath', JSON.stringify(execPath), 'no throw');
    } catch (e) {
      console.log('execPath', JSON.stringify(execPath), e.code, e.message);
    }
  }
  await watch('fork:', fork(__filename, [], { execPath: '/nonexistent/node' }));
  await watch('fork, missing cwd:', fork(__filename, [], { cwd: '/nonexistent/dir' }));
  await watch('spawn ipc:', spawn('/nonexistent/prog', [], { stdio: ['pipe', 'pipe', 'pipe', 'ipc'] }));
})();
