export const SKIP = {
  m17t: 'a readline tty fixture: the host pty driver is not part of this harness (the committed readline-tty and repl-tty tests cover it)',
  m18t: 'a readline tty fixture (see m17t)',
  m43t: 'a readline tty fixture (see m17t)',
  m37: 'tty keys only (see m17t)',
};

export const SKIP_CASES = {
  'm2g/wsecho.js': 'talks to the public wss://echo.websocket.org, so the remote end and the runner network are in the loop (#241); the committed websocket-loopback integration tests cover WebSocket',
  'm2h/wsecho.js': 'the same public echo server as m2g/wsecho.js (#241)',
};

export const NORMALIZE = [
  [/^m1[12]\//, [[/\b(\d+(\.\d+)?|PORT) ?ms\b/g, 'N ms']]],
  [/^m38\/chprobe/, [[/\d+\.\d+ms/g, 'Nms']]],
  [/^m45\//, [[/report\.\d{8}\.\d{6}\./g, 'report.DATE.']]],
  [/^m5\//, [[/\b([xm]-)[A-Za-z0-9]{6}\b/g, '$1XXXXXX']]],
  [/^m30\//, [[/stopped ~ \S+ ms/g, 'stopped ~ N ms']]],
];

export const ROW_DIRS = ['m46', 'm47', 'm49', 'm51', 'm54'];

export const ARGV = {
  m3: [
    ['-e require + import() stays CJS', ['-e', "const fs = require('fs'); import('fs').then((m) => console.log('cjs:', typeof require, typeof module, typeof m.readFileSync, typeof m.default.readFileSync))"]],
    ['-e static import is ESM', ['-e', "import fs from 'fs'; import { join } from 'path'; console.log('esm:', typeof fs.readFileSync, typeof join, typeof require, typeof import.meta.url)"]],
    ['-e top-level await is ESM', ['-e', "const x = await Promise.resolve(7); console.log('tla -e', x, typeof require)"]],
    ['-p with import()', ['-p', "typeof require + ' ' + typeof import('fs').then"]],
    ['-p string', ['-p', "'abc'"]],
    ['-p sum', ['-p', '1+1']],
    ['-p typeof require', ['-p', "typeof require + ' x'"]],
    ['-p array', ['-p', "[1,'a']"]],
    ['-p object', ['-p', "({a:'b'})"]],
    ['tla.mjs', ['tla.mjs']],
    ['mjs imports CJS + exports conditions', ['mjs-cjs.mjs']],
    ['require(esm) + import() from CJS', ['req-esm.js']],
    ['ambiguous .js with import (detect-module)', ['ambiguous.js']],
    ['.cjs dynamic import of .mjs', ['cjs-dyn.cjs']],
    ['missing named export (error)', ['err.mjs']],
  ],
};

const D = '/home/cone';

export const ROWS = [
  {
    name: 'm47-chmod',
    files: { '/opt/m47/chmod.js': 'm47/chmod.js' },
    reference: 'host-m47-*.txt',
    steps: [
      { label: 'setup', cmd: 'chmod -R a+rX /opt/m47; mkdir -p /root/m47 /tmp/rootd; echo r > /tmp/rootf; stat -c "%A %u:%g %s %n" /tmp/rootf; id; node --version' },
      { label: 'cone setup', user: 'cone', cwd: D, cmd: 'mkdir -p ~/m47; echo c > ~/m47/cf; stat -c "%A %u:%g %s %n" ~/m47/cf; pwd; echo $HOME' },
      { label: 'cone2 setup', user: 'cone2', cwd: '/home/cone2', cmd: 'mkdir -p ~/m47; echo c2 > ~/m47/c2f; chmod 755 ~ ~/m47; stat -c "%A %u:%g %s %n" ~/m47/c2f' },
      ...['owner', 'errors', 'spawn', 'mkdir'].flatMap((md) => [
        { label: `root ${md}`, cmd: `node /opt/m47/chmod.js ${md} /root/m47; echo "rc=$?"` },
        { label: `cone ${md}`, user: 'cone', cmd: `node /opt/m47/chmod.js ${md} ${D}/m47; echo "rc=$?"` },
      ]),
      {
        label: 'bash view after cone spawn',
        user: 'cone',
        cmd: `C=${D}/m47; stat -c '%a %u:%g %n' $C/s.sh $C/f $C/d; chmod 755 $C/s.sh; $C/s.sh from-bash; cd $C && ./s.sh rel; node -e "require('fs').chmodSync('$C/s.sh', 0o750)"; stat -c %a $C/s.sh; $C/s.sh after-node-750; node -e "require('fs').chmodSync('$C/s.sh', 0o640)"; $C/s.sh after-node-640; echo "rc=$?"`,
      },
      { label: 'cone other: root file', user: 'cone', cmd: 'node /opt/m47/chmod.js other /tmp /tmp/rootf; echo "rc=$?"' },
      { label: 'cone other: cone2 file', user: 'cone', cmd: 'node /opt/m47/chmod.js other /home/cone2/m47 /home/cone2/m47/c2f; echo "rc=$?"' },
      { label: 'root other: cone file', cmd: `node /opt/m47/chmod.js other ${D}/m47 ${D}/m47/cf; echo "rc=$?"; stat -c "%a %u:%g" ${D}/m47/cf` },
      {
        label: 'cone2 spawn cone file 755',
        user: 'cone2',
        cmd: `node -e "const r=require('child_process').spawnSync('${D}/m47/s.sh',['x'],{encoding:'utf8'});console.log(r.error?r.error.code:r.stdout.trim())"; stat -c "%a %U" ${D}/m47/s.sh`,
      },
    ],
  },
  {
    name: 'm49-eacces',
    files: { '/opt/m49/eacces.js': 'm49/eacces.js' },
    reference: 'host-m49.txt',
    steps: [
      { label: 'setup', cmd: 'chmod -R a+rX /opt/m49; mkdir -p /root/m49; node --version' },
      { label: 'cone eacces', user: 'cone', cwd: D, cmd: `mkdir -p ~/m49; node /opt/m49/eacces.js ${D}/m49` },
      { label: 'root eacces', cmd: 'node /opt/m49/eacces.js /root/m49' },
    ],
  },
  {
    name: 'm51-rm',
    files: { '/opt/m51/rm.js': 'm51/rm.js' },
    reference: 'host-m51-local.txt',
    steps: [
      { label: 'setup', cmd: 'chmod -R a+rX /opt/m51; mkdir -p /root/m51; node --version' },
      { label: 'cone local', user: 'cone', cwd: D, cmd: `mkdir -p ~/m51; node /opt/m51/rm.js local ${D}/m51` },
      { label: 'root local', cmd: 'node /opt/m51/rm.js local /root/m51' },
      { label: 'cone2 tree', user: 'cone2', cmd: 'rm -rf /tmp/c2t; mkdir -p /tmp/c2t/a/b; echo 1 > /tmp/c2t/f; echo 2 > /tmp/c2t/a/b/g; chmod -R a+rX /tmp/c2t; stat -c "%A %u:%g %s %n" /tmp /tmp/c2t' },
      { label: 'cone other: cone2 tree in /tmp', user: 'cone', cmd: 'node /opt/m51/rm.js other /tmp /tmp/c2t' },
      { label: 'root tree', cmd: 'rm -rf /srv/rt; mkdir -p /srv/rt/a/b; echo 1 > /srv/rt/f; echo 2 > /srv/rt/a/b/g; chmod -R a+rX /srv/rt; stat -c "%A %u:%g %s %n" /srv /srv/rt' },
      { label: 'cone other: root tree', user: 'cone', cmd: 'node /opt/m51/rm.js other /srv /srv/rt' },
      {
        label: 'cone rm /etc recursive force',
        user: 'cone',
        cmd: `node -e "try { require('fs').rmSync('/etc', { recursive: true, force: true }); console.log('rm ok?!') } catch (e) { console.log(e.code, e.syscall, e.path) }"; ls /etc | wc -l; test -f /etc/passwd && echo passwd-still-there`,
      },
      {
        label: 'cone rm /proc /dev',
        user: 'cone',
        cmd: `node -e "for (const p of ['/proc', '/dev']) { try { require('fs').rmSync(p, { recursive: true }); console.log(p, 'rm ok?!') } catch (e) { console.log(p, e.code, e.syscall, e.path) } }"; ls /dev | head -3`,
      },
      { label: 'root rm mounted /proc', cmd: `node -e "try { require('fs').rmSync('/proc/self', { recursive: true }); console.log('ok') } catch (e) { console.log(e.code, e.syscall) }"` },
    ],
  },
  {
    name: 'devrm',
    files: {},
    steps: [
      { label: 'before', cmd: 'stat -c "%n %a %u:%g %F" /etc/* /dev/* | md5sum; ls -A /etc | tr "\\n" " "; echo; ls -A /dev | tr "\\n" " "' },
      {
        label: 'cone rm /dev',
        user: 'cone',
        cmd: `node -e "try { require('fs').rmSync('/dev', { recursive: true }); console.log('returned ok') } catch (e) { console.log(e.code, e.syscall, e.path) } try { require('fs').rmSync('/dev/null'); console.log('null ok') } catch (e) { console.log('null', e.code, e.syscall) } require('fs').promises.rm('/dev', { recursive: true }).then(() => console.log('promises ok'), (e) => console.log('promises', e.code, e.syscall))"`,
      },
      { label: 'cone rm /etc', user: 'cone', cmd: `node -e "try { require('fs').rmSync('/etc', { recursive: true, force: true }) } catch (e) { console.log(e.code, e.syscall, e.path) }"` },
      { label: 'after', cmd: 'stat -c "%n %a %u:%g %F" /etc/* /dev/* | md5sum; ls -A /etc | tr "\\n" " "; echo; ls -A /dev | tr "\\n" " "' },
    ],
  },
  {
    name: 'm52-modes',
    files: { '/opt/m52/modes.js': 'm52/modes.js' },
    reference: 'host-m52-modes.txt',
    steps: [
      { label: 'setup', cmd: 'chmod -R a+rX /opt/m52; mkdir -p /root/m52; node --version' },
      { label: 'cone modes', user: 'cone', cwd: D, cmd: `mkdir -p ~/m52; node /opt/m52/modes.js ${D}/m52` },
      { label: 'root modes', cmd: 'node /opt/m52/modes.js /root/m52' },
      {
        label: 'umask',
        user: 'cone',
        cmd: `umask; umask 027; node -p "process.umask().toString(8)"; cat /proc/self/status 2>/dev/null | grep -i umask; umask 077; node -e "require('fs').writeFileSync('/tmp/um', 'x')"; stat -c %a /tmp/um`,
      },
    ],
  },
  {
    name: 'm54-umask-bc-dns',
    files: { '/opt/m54/um.js': 'm54/um.js', '/opt/m54/bc.js': 'm54/bc.js', '/opt/m54/dnsp.js': 'm54/dnsp.js' },
    reference: 'host-m54-*.txt',
    steps: [
      { label: 'setup', cmd: 'chmod -R a+rX /opt/m54; mkdir -p /root/m54; node --version' },
      { label: 'cone um', user: 'cone', cwd: D, cmd: `umask 022; mkdir -p ~/m54; node /opt/m54/um.js ${D}/m54` },
      { label: 'cone bc', user: 'cone', cmd: 'node /opt/m54/bc.js' },
      { label: 'cone dnsp', user: 'cone', cmd: 'node /opt/m54/dnsp.js' },
      { label: 'root um', cmd: 'umask 022; node /opt/m54/um.js /root/m54' },
      {
        label: 'shell umask',
        user: 'cone',
        cmd: `umask 077; node -p "process.umask().toString(8)"; node -e "require('fs').writeFileSync('/tmp/um', 'x'); require('fs').mkdirSync('/tmp/umd')"; stat -c %a /tmp/um /tmp/umd; grep -i umask /proc/self/status 2>/dev/null`,
      },
    ],
  },
  {
    name: 'm46-cred',
    files: { '/opt/m46/cred.js': 'm46/cred.js' },
    steps: [
      { label: 'setup', cmd: 'chmod -R a+rX /opt/m46; id; tail -3 /etc/passwd; tail -3 /etc/group; node --version' },
      ...['root-drop', 'root-euid', 'unknown'].map((s) => ({ label: `root ${s}`, cmd: `node /opt/m46/cred.js ${s}; echo "rc=$?"; stat -c "%A %u:%g %s %n" /tmp/cred-${s}/* 2>/dev/null` })),
      { label: 'cone cone', user: 'cone', cmd: 'node /opt/m46/cred.js cone; echo "rc=$?"' },
      {
        label: 'root drop then spawn sh writes',
        cmd: `node -e "process.setgid('cone'); process.setuid('cone'); require('child_process').execSync('touch /tmp/kidfile; id -u; id -g', { stdio: 'inherit' })"; stat -c "%A %u:%g %s %n" /tmp/kidfile`,
      },
      { label: 'process ids as cone', user: 'cone', cmd: `node -p "[process.getuid(), process.geteuid(), process.getgid(), process.getgroups().join(' ')].join(' ')"` },
    ],
  },
];
