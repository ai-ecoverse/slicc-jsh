/**
 * process.setuid / setgid / seteuid / setegid / setgroups / initgroups, as
 * Node 22.22.0's (lib/internal/bootstrap/switches/does_own_process_state.js
 * over src/node_credentials.cc), on the kernel's credentials
 * (`ctx.sync.cred()` / `ctx.sync.setcred(change)`, POSIX setresuid rules).
 * Names resolve through /etc/passwd and /etc/group, as getpwnam/getgrnam do.
 * Only installed where the kernel has the calls.
 */
import { ERR_INVALID_ARG_TYPE, nodeError, validateArray, validateUint32 } from './node-errors.mjs';

const ERRNO = { EPERM: 1, EINVAL: 22, ENOMEM: 12 };
const STRERROR = { EPERM: 'Operation not permitted', EINVAL: 'Invalid argument', ENOMEM: 'Cannot allocate memory' };

function readTable(ctx, path) {
  try {
    const bytes = ctx.sync.fs.readFile(path);
    const text = typeof bytes === 'string' ? bytes : new TextDecoder().decode(bytes);
    return text
      .split('\n')
      .filter((l) => l && !l.startsWith('#'))
      .map((l) => l.split(':'));
  } catch {
    return [];
  }
}

/** Node's env->ThrowErrnoException(errno, syscall): `EPERM, Operation not permitted`. */
function errnoException(err, syscall) {
  const code = err?.code in ERRNO ? err.code : 'EPERM';
  const e = new Error(`${code}, ${STRERROR[code]}`);
  Object.assign(e, { errno: ERRNO[code], code, syscall });
  return e;
}

export function installCredentials(process) {
  const ctx = process._ctx;
  const sync = ctx?.sync;
  if (typeof sync?.setcred !== 'function' || typeof sync?.cred !== 'function') return;

  const uidOf = (name) => readTable(ctx, '/etc/passwd').find((f) => f[0] === name)?.[2];
  const gidOf = (name) => readTable(ctx, '/etc/group').find((f) => f[0] === name)?.[2];
  const nameOfUid = (uid) => readTable(ctx, '/etc/passwd').find((f) => Number(f[2]) === uid)?.[0];
  /** A uid / gid: the number, or the name's (undefined when unknown). */
  const resolve = (id, lookup) => {
    if (typeof id === 'number') return id >>> 0;
    const n = lookup(id);
    return n === undefined ? undefined : Number(n);
  };
  const apply = (change, syscall) => {
    try {
      sync.setcred(change);
    } catch (err) {
      throw errnoException(err, syscall);
    } finally {
      // getuid() & co. read the new ids.
      process._credCache = undefined;
    }
  };

  function validateId(id, name) {
    if (typeof id === 'number') validateUint32(id, name);
    else if (typeof id !== 'string') throw ERR_INVALID_ARG_TYPE(name, ['number', 'string'], id);
  }
  const unknown = (type, id) => nodeError(Error, 'ERR_UNKNOWN_CREDENTIAL', `${type} identifier does not exist: ${id}`);

  // Linux setuid(2) / setgid(2): privileged (euid 0) sets real, effective and
  // saved; otherwise only the effective id (to the real or saved one).
  const wrapIdSetter = (type, lookup, change, syscall) =>
    function (id) {
      validateId(id, 'id');
      const n = resolve(id, lookup);
      if (n === undefined) throw unknown(type, id);
      apply(change(n, sync.cred()), syscall);
    };
  const define = (name, fn, length = 1) => {
    Object.defineProperty(fn, 'length', { value: length });
    Object.defineProperty(process, name, { value: fn, writable: true, enumerable: true, configurable: true });
  };

  define(
    'initgroups',
    function initgroups(user, extraGroup) {
      validateId(user, 'user');
      validateId(extraGroup, 'extraGroup');
      // node_credentials.cc: a uid is looked up for its name, a name is used as given.
      const name = typeof user === 'number' ? nameOfUid(user >>> 0) : user;
      if (name === undefined) throw unknown('User', user);
      const extra = resolve(extraGroup, gidOf);
      if (extra === undefined) throw unknown('Group', extraGroup);
      // initgroups(3): the groups that list the user, and extraGroup.
      const groups = [extra];
      for (const [, , gid, members = ''] of readTable(ctx, '/etc/group')) {
        const n = Number(gid);
        if (members.split(',').includes(name) && !groups.includes(n)) groups.push(n);
      }
      apply({ groups }, 'initgroups');
    },
    2,
  );
  define('setgroups', function setgroups(groups) {
    validateArray(groups, 'groups');
    for (let i = 0; i < groups.length; i++) validateId(groups[i], `groups[${i}]`);
    const ids = [];
    for (let i = 0; i < groups.length; i++) {
      const n = resolve(groups[i], gidOf);
      if (n === undefined) throw unknown('Group', groups[i]);
      ids.push(n);
    }
    apply({ groups: ids }, 'setgroups');
  });
  define(
    'setegid',
    wrapIdSetter('Group', gidOf, (n) => ({ egid: n }), 'setegid'),
  );
  define(
    'seteuid',
    wrapIdSetter('User', uidOf, (n) => ({ euid: n }), 'seteuid'),
  );
  define(
    'setgid',
    wrapIdSetter('Group', gidOf, (n, c) => (c.euid === 0 ? { rgid: n, egid: n, sgid: n } : { egid: n }), 'setgid'),
  );
  define(
    'setuid',
    wrapIdSetter('User', uidOf, (n, c) => (c.euid === 0 ? { ruid: n, euid: n, suid: n } : { euid: n }), 'setuid'),
  );
  // Node's wrapIdSetter functions are anonymous.
  for (const name of ['setegid', 'seteuid', 'setgid', 'setuid']) {
    Object.defineProperty(process[name], 'name', { value: '' });
  }
}
