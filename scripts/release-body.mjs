/**
 * Sections of a GitHub release body that jobs own: `<!-- name -->` … `<!--
 * /name -->`, one per job (release-line, cert-review). A job replaces only
 * its own section, in place, or appends it when it's absent; everything
 * else in the body stays, so reruns in any order never drop another's.
 */
export function replaceSection(body, name, content) {
  const open = `<!-- ${name} -->`;
  const close = `<!-- /${name} -->`;
  const section = `${open}\n${content.replace(/\n+$/, '')}\n${close}`;
  const start = body.indexOf(open);
  const end = start === -1 ? -1 : body.indexOf(close, start + open.length);
  if (start !== -1 && end !== -1) return body.slice(0, start) + section + body.slice(end + close.length);
  return `${body.replace(/\s+$/, '')}${body.trim() ? '\n\n' : ''}${section}\n`;
}
