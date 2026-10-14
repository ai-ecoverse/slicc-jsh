// process.setuid & co.: what doesn't depend on being root (host Node runs as
// a user, the kernel's program as root): argument checks, unknown names,
// setting an id to the one the process has, and getgroups.
const show = (label, fn) => {
  try {
    console.log(label, JSON.stringify(fn()));
  } catch (e) {
    console.log(label, 'THROWS', e.name, e.code, JSON.stringify(e.message));
  }
};
for (const name of ['setuid', 'setgid', 'seteuid', 'setegid']) {
  show(`${name} -1`, () => process[name](-1));
  show(`${name} 1.5`, () => process[name](1.5));
  show(`${name} {}`, () => process[name]({}));
  show(`${name} unknown name`, () => process[name]('no-such-credential'));
}
show('setuid own uid', () => process.setuid(process.getuid()));
show('seteuid own euid', () => process.seteuid(process.geteuid()));
show('setgid own gid', () => process.setgid(process.getgid()));
show('setegid own egid', () => process.setegid(process.getegid()));
show('setgroups 1', () => process.setgroups(1));
show('setgroups [-1]', () => process.setgroups([-1]));
show('setgroups [null]', () => process.setgroups([null]));
show('setgroups unknown', () => process.setgroups(['no-such-credential']));
show('initgroups bad user', () => process.initgroups({}, 0));
show('initgroups bad group', () => process.initgroups(0, {}));
show('initgroups unknown uid', () => process.initgroups(4000000000, 0));
show('initgroups unknown group', () => process.initgroups(0, 'no-such-credential'));
show('getgroups has egid', () => process.getgroups().includes(process.getegid()));
