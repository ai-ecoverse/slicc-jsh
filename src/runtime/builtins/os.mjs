/** Minimal os shim (linux/x64), env-aware tmpdir/homedir. */

export function createOs(env = {}) {
  return {
    platform: () => 'linux',
    arch: () => 'x64',
    EOL: '\n',
    type: () => 'Linux',
    release: () => '0.0.0',
    hostname: () => 'slicc',
    cpus: () => [{ model: 'virtual', speed: 0, times: { user: 0, nice: 0, sys: 0, idle: 0, irq: 0 } }],
    totalmem: () => 8 * 1024 * 1024 * 1024,
    freemem: () => 4 * 1024 * 1024 * 1024,
    uptime: () => 0,
    endianness: () => 'LE',
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
