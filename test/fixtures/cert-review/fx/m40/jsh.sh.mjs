const r = (n, f) => ({ name: n, cmd: `"\${JSH:-jsh}" ${f} > /tmp/m40j.out 2>&1; echo "rc=$?"; head -6 /tmp/m40j.out` });
export default [r('jsh-body', 'jsh/body.jsh'), r('jsh-shebang', 'jsh/bang.jsh'), r('jsh-return', 'jsh/ret.jsh')];
