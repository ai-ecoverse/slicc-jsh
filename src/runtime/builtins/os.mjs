/** Minimal os shim (linux/x64), env-aware tmpdir/homedir. */

export function createOs(env = {}) {
  return {
    platform: () => 'linux',
    arch: () => 'x64',
    EOL: '\n',
    type: () => 'Linux',
    release: () => '0.0.0',
    hostname: () => 'slicc',
    cpus: () => [{ model: 'virtual', speed: 0 }],
    tmpdir: () => {
      const t = env.TMPDIR || env.TMP || env.TEMP;
      return t?.trim() ? t : '/tmp';
    },
    homedir: () => {
      const h = env.HOME;
      return h?.trim() ? h : '/home/user';
    },
  };
}
