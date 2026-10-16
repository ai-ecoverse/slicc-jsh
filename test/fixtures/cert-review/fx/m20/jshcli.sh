# kernel-only: cli.die / cli.help through jsh .jsh scripts; finally side effects
rm -f /tmp/j.*
cat > /tmp/die.jsh <<'X'
const fs = require('fs'); const cli = require('sliccy:cli');
try { cli.die('fatal thing', 5); } finally { fs.writeFileSync('/tmp/j.die-finally', 'x'); }
X
cat > /tmp/help.jsh <<'X'
const fs = require('fs'); const cli = require('sliccy:cli');
try { cli.help ? cli.help('usage: thing') : console.log('no cli.help'); } finally { fs.writeFileSync('/tmp/j.help-finally', 'x'); }
X
cat > /tmp/exit.jsh <<'X'
const fs = require('fs');
process.on('exit', (c) => fs.writeFileSync('/tmp/j.exit-listener', String(c)));
try { process.exit(7); } finally { fs.writeFileSync('/tmp/j.exit-finally', 'x'); }
X
jsh /tmp/die.jsh; echo "die rc=$?"; jsh /tmp/help.jsh; echo "help rc=$?"; jsh /tmp/exit.jsh; echo "exit rc=$?"
for f in /tmp/j.*; do [ -e "$f" ] && echo "$f: $(cat $f)"; done; true
