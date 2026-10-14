/**
 * The slicc-kernel version a program runs on: ctx.kernel.version (or
 * ctx.sync.kernel.version), a semver such as '1.88.0', from slicc-kernel
 * 1.88.0 on (ai-ecoverse/slicc-kernel#518). An older kernel has no
 * ctx.kernel, so null means "older than 1.88.0".
 */
export function kernelVersion(ctx) {
  const v = ctx?.kernel?.version ?? ctx?.sync?.kernel?.version;
  return typeof v === 'string' ? v : null;
}

/** Whether the kernel is at least `min` (x.y.z); false when it doesn't say (< 1.88.0). */
export function kernelAtLeast(ctx, min) {
  const v = kernelVersion(ctx);
  if (!v) return false;
  const a = v.split(/[.+-]/).map(Number);
  const b = min.split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) > (b[i] || 0);
  return true;
}
