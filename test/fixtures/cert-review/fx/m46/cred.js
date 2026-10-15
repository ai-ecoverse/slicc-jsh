const fs = require('fs'), cp = require('child_process'), os = require('os');
const T = (l, f) => { try { const v = f(); console.log(l, v === undefined ? 'ok' : JSON.stringify(v)); } catch (e) { console.log(l, 'ERR', e.code ?? e.name, e.message.slice(0, 70)); } };
const ids = () => ({ uid: process.getuid(), euid: process.geteuid(), gid: process.getgid(), egid: process.getegid(), groups: process.getgroups() });
const step = process.argv[2];
console.log('start', JSON.stringify(ids()), 'user', os.userInfo().username);
const kidId = () => cp.execFileSync('id', { encoding: 'utf8' }).trim();
const own = (p) => { fs.writeFileSync(p, 'x'); const s = fs.statSync(p); return `${s.uid}:${s.gid}`; };
const D = '/tmp/cred-' + step; fs.mkdirSync(D, { recursive: true }); try { fs.chmodSync(D, 0o777); } catch (e) { console.log('chmod', e.code); }
console.log('dir mode', (fs.statSync(D).mode & 0o7777).toString(8), 'uid', fs.statSync(D).uid);
if (step === 'root-drop') {
  T('own before', () => own(D + '/before'));
  T('setgroups([])', () => process.setgroups([]));
  T('initgroups cone', () => process.initgroups('cone', 'cone'));
  T('groups after initgroups', () => process.getgroups());
  T('setgid cone (name)', () => process.setgid('cone'));
  T('setuid cone (name)', () => process.setuid('cone'));
  T('ids after', () => ids());
  T('userInfo', () => os.userInfo().username);
  T('setuid 0 again', () => process.setuid(0));
  T('seteuid 0', () => process.seteuid(0));
  T('setgid 0', () => process.setgid(0));
  T('dir mode now', () => (fs.statSync(D).mode & 0o7777).toString(8));
  T('own after', () => own(D + '/after'));
  T('own after in /tmp', () => own('/tmp/after-drop-' + process.pid));
  T('child id', () => kidId());
  T('read /root', () => fs.readdirSync('/root').length);
}
if (step === 'root-euid') {
  T('seteuid 1000', () => process.seteuid(1000));
  T('ids', () => ids());
  T('own with euid 1000', () => own(D + '/e'));
  T('own with euid 1000 in /tmp', () => own('/tmp/euid-' + process.pid));
  T('seteuid 0 (saved uid)', () => process.seteuid(0));
  T('ids back', () => ids());
  T('setegid cone', () => process.setegid('cone'));
  T('ids egid', () => ids());
}
if (step === 'unknown') {
  T('setuid nosuchuserzz', () => process.setuid('nosuchuserzz'));
  T('setgid nosuchgroupzz', () => process.setgid('nosuchgroupzz'));
  T('initgroups nosuchuserzz', () => process.initgroups('nosuchuserzz', 0));
  T('setuid 4294967295', () => process.setuid(4294967295));
  T('setuid -1', () => process.setuid(-1));
  T('setuid {}', () => process.setuid({}));
  T('setgroups ["nosuchgroupzz"]', () => process.setgroups(['nosuchgroupzz']));
}
if (step === 'cone') {
  T('setuid 0', () => process.setuid(0));
  T('seteuid 0', () => process.seteuid(0));
  T('setgid 0', () => process.setgid(0));
  T('setgroups [0]', () => process.setgroups([0]));
  T('setuid own (1000)', () => process.setuid(1000));
  T('setuid cone2 (1001)', () => process.setuid('cone2'));
  T('ids', () => ids());
}
