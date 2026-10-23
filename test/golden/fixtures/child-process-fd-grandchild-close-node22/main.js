const cp = require('child_process');
const fs = require('fs');
const path = require('path');
const show = (file) => JSON.stringify(fs.readFileSync(file, 'utf8').replace('x'.repeat(100000), '<100000 x>'));
const run = (name, slots, next) => {
  const flag = `flag-${name}`;
  const outs = [...new Set(slots.filter((s) => typeof s === 'string' && s !== 'ignore'))];
  const fds = Object.fromEntries(outs.map((o) => [o, fs.openSync(`${name}-${o}.txt`, 'w')]));
  const stdio = ['ignore', ...slots.map((s) => fds[s] ?? s)];
  const c = cp.spawn(process.execPath, [path.join(__dirname, 'child.js'), flag], { stdio });
  const log = [];
  c.on('exit', (code) => {
    log.push(`exit ${code} ${outs.map((o) => fs.fstatSync(fds[o]).size).join(' ')}`);
    process.nextTick(() => log.push('tick'));
  });
  c.on('close', (code) => {
    log.push(`close ${code}`);
    fs.writeFileSync(flag, '');
    for (const fd of Object.values(fds)) fs.closeSync(fd);
    const first = `${name}-${outs[0]}.txt`;
    const start = Date.now();
    const poll = () => {
      if (!fs.readFileSync(first, 'utf8').includes('grandchild') && Date.now() - start < 10000) return setTimeout(poll, 20);
      console.log(name, log.join(', '));
      for (const o of outs) {
        console.log(' ', o, show(`${name}-${o}.txt`));
        fs.rmSync(`${name}-${o}.txt`);
      }
      fs.rmSync(flag);
      next();
    };
    poll();
  });
};
const cases = [
  ['one fd', ['a', 'a']],
  ['two fds', ['a', 'b']],
  ['stdout fd', ['a', 'ignore']],
];
const go = () => {
  const c = cases.shift();
  if (c) run(c[0].replace(' ', '-'), c[1], go);
};
go();
