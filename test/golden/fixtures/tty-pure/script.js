const tty = require('tty');
const ws = Object.create(tty.WriteStream.prototype);
const envs = [{}, { TERM: 'dumb' }, { TERM: 'xterm' }, { TERM: 'xterm-256color' }, { TERM: 'xterm-kitty' },
  { COLORTERM: 'truecolor' }, { COLORTERM: '24bit', TERM: 'xterm' }, { NO_COLOR: '1', TERM: 'xterm-256color' },
  { NODE_DISABLE_COLORS: '1', TERM: 'xterm' }, { FORCE_COLOR: '0' }, { FORCE_COLOR: '1' }, { FORCE_COLOR: '2' },
  { FORCE_COLOR: '3' }, { FORCE_COLOR: '' }, { CI: '1', GITHUB_ACTIONS: '1' }, { CI: '1', TRAVIS: '1' },
  { CI: '1' }, { TERM: 'screen' }, { TERM: 'linux' }, { TERM_PROGRAM: 'iTerm.app', TERM_PROGRAM_VERSION: '3.4' },
  { TERM_PROGRAM: 'Apple_Terminal' }, { TMUX: '1' }, { TEAMCITY_VERSION: '2020.1' }];
for (const env of envs) {
  console.log(JSON.stringify(env), ws.getColorDepth(env), ws.hasColors(env), ws.hasColors(16, env), ws.hasColors(256, env), ws.hasColors(2 ** 24, env));
}
try {
  ws.hasColors('x');
} catch (e) {
  console.log('hasColors bad', e.code, e.message);
}
const out = [];
const fake = Object.assign(Object.create(tty.WriteStream.prototype), {
  write(s, cb) {
    out.push(s);
    if (typeof cb === 'function') cb();
    return true;
  },
});
const show = (label, f) => {
  out.length = 0;
  let r;
  try {
    r = f();
  } catch (e) {
    r = `THROW ${e.name} ${e.code} ${e.message}`;
  }
  console.log(label, JSON.stringify(r), JSON.stringify(out));
};
show('cursorTo 3', () => fake.cursorTo(3));
show('cursorTo 3 4', () => fake.cursorTo(3, 4));
show('cursorTo cb', () => fake.cursorTo(1, () => out.push('cb')));
show('cursorTo NaN', () => fake.cursorTo(NaN));
show('cursorTo y only', () => fake.cursorTo(undefined, 2));
show('moveCursor 2 -1', () => fake.moveCursor(2, -1));
show('moveCursor -3 2', () => fake.moveCursor(-3, 2));
show('moveCursor 0 0', () => fake.moveCursor(0, 0));
show('clearLine -1', () => fake.clearLine(-1));
show('clearLine 0', () => fake.clearLine(0));
show('clearLine 1', () => fake.clearLine(1));
show('clearScreenDown', () => fake.clearScreenDown());
show('getWindowSize', () => Object.assign(Object.create(tty.WriteStream.prototype), { columns: 7, rows: 3 }).getWindowSize());
show('isTTY proto', () => [tty.WriteStream.prototype.isTTY, tty.ReadStream.prototype.isTTY]);
